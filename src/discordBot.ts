import { randomUUID } from "node:crypto";

import {
  ApplicationIntegrationType,
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message
} from "discord.js";

import { installGuildChannel, isGuildChannelAllowed, removeGuildInstallation } from "./bridgePolicy";
import { buildDiscordRelayPrompt } from "./prompt";
import { rememberMessageId, type BridgeState } from "./state";
import type {
  BridgeConfig,
  DiscordAttachmentContext,
  DiscordMessageContext,
  DiscordOutboundAttachment,
  DiscordOutboundEmbed,
  DiscordReplyTarget,
  DiscordRelayRequest,
  PokeSendResult
} from "./types";

const SERVER_ATTACHMENT_OPTION_COUNT = 5;
const COMMAND_NAME = "poke";
const COMMAND_PREFIX = "!";

function isDmMessage(message: Message): boolean {
  return message.guildId == null;
}

function isSendableChannel(channel: unknown): channel is { send: (content: string | { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; }) => Promise<{ id: string }>; isTextBased: () => boolean; } {
  return typeof channel === "object" && channel != null && "send" in channel && typeof (channel as { send?: unknown }).send === "function";
}

function isTypingChannel(channel: unknown): channel is { isTextBased: () => boolean; sendTyping: () => Promise<unknown>; } {
  return typeof channel === "object" && channel != null && "sendTyping" in channel && typeof (channel as { sendTyping?: unknown }).sendTyping === "function";
}

function formatAttachment(attachment: { name: string; url: string; contentType?: string | null; size: number; }): DiscordAttachmentContext {
  return {
    name: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType ?? null,
    size: attachment.size
  };
}

function getMessageAttachments(message: Message): DiscordAttachmentContext[] {
  return Array.from(message.attachments.values()).map(formatAttachment);
}

function getCommandAttachments(interaction: ChatInputCommandInteraction): DiscordAttachmentContext[] {
  const attachments: DiscordAttachmentContext[] = [];
  for (let index = 1; index <= SERVER_ATTACHMENT_OPTION_COUNT; index++) {
    const attachment = interaction.options.getAttachment(`attachment${index}`);
    if (attachment) attachments.push(formatAttachment(attachment));
  }
  return attachments;
}

function getChannelLabel(channel: Message["channel"] | ChatInputCommandInteraction["channel"]): string | null {
  if (!channel || !channel.isTextBased() || !("name" in channel) || typeof channel.name !== "string") return null;
  return `#${channel.name}`;
}

function buildReplyTarget(channelId: string, label: string | null, mode: DiscordReplyTarget["mode"]): DiscordReplyTarget {
  return {
    channelId,
    label,
    mode,
    createdAt: Date.now()
  };
}

function guessAttachmentName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    return name?.trim() || "attachment";
  } catch {
    return "attachment";
  }
}

async function buildAttachmentBuilders(attachments: DiscordOutboundAttachment[]): Promise<AttachmentBuilder[]> {
  const built = await Promise.all(attachments.map(async attachment => {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch attachment ${attachment.url}: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const name = attachment.name?.trim() || guessAttachmentName(attachment.url);
    return new AttachmentBuilder(buffer, { name });
  }));

  return built;
}

function buildEmbedBuilder(embed: DiscordOutboundEmbed): EmbedBuilder {
  const builder = new EmbedBuilder();

  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.url) builder.setURL(embed.url);
  if (typeof embed.color === "number") builder.setColor(embed.color);
  if (embed.timestamp) builder.setTimestamp(new Date(embed.timestamp));
  if (embed.footer) builder.setFooter({ text: embed.footer.text, iconURL: embed.footer.iconUrl });
  if (embed.author) builder.setAuthor({ name: embed.author.name, url: embed.author.url, iconURL: embed.author.iconUrl });
  if (embed.thumbnailUrl) builder.setThumbnail(embed.thumbnailUrl);
  if (embed.imageUrl) builder.setImage(embed.imageUrl);
  if (embed.fields?.length) {
    builder.setFields(embed.fields.map(field => ({ name: field.name, value: field.value, inline: field.inline ?? false })));
  }

  return builder;
}

interface OutboundMessageOptions {
  replyToMessageId?: string;
  attachments?: DiscordOutboundAttachment[];
  embeds?: DiscordOutboundEmbed[];
}

async function sendChunks(channel: { send: (content: string | { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; }) => Promise<{ id: string }>; }, content: string, options: OutboundMessageOptions = {}): Promise<string[]> {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 2000) {
    const breakPoint = remaining.lastIndexOf("\n", 2000);
    const splitAt = breakPoint > 0 ? breakPoint : 2000;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.length || !chunks.length) chunks.push(remaining);

  const builtAttachments = options.attachments?.length ? await buildAttachmentBuilders(options.attachments) : [];
  const builtEmbeds = options.embeds?.map(buildEmbedBuilder) ?? [];
  const messageIds: string[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index] ?? "";
    const payload: { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; } = {};

    if (chunk.length) payload.content = chunk;
    if (index === 0 && options.replyToMessageId) {
      payload.reply = {
        messageReference: options.replyToMessageId,
        failIfNotExists: false
      };
    }
    if (index === 0 && builtAttachments.length) payload.files = builtAttachments;
    if (index === 0 && builtEmbeds.length) payload.embeds = builtEmbeds;

    const sent = await channel.send(payload);
    messageIds.push(sent.id);
  }

  return messageIds;
}

function readCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(COMMAND_PREFIX)) return null;
  return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}

function stripBotMentions(content: string, botUserId: string): string {
  const mentionPattern = new RegExp(`^<@!?${botUserId}>\\s*`, "g");
  return content.replace(mentionPattern, "").trim();
}

async function isReplyToBotMessage(message: Message, botUserId: string): Promise<boolean> {
  const referenceId = message.reference?.messageId;
  if (!referenceId || !message.channel || !message.channel.isTextBased() || !("messages" in message.channel)) return false;

  try {
    const referenced = await message.channel.messages.fetch(referenceId);
    return referenced.author.id === botUserId;
  } catch {
    return false;
  }
}

async function collectChannelContext(channel: Message["channel"] | ChatInputCommandInteraction["channel"] | null | undefined, limit: number): Promise<DiscordMessageContext[]> {
  if (!channel || !channel.isTextBased() || !("messages" in channel)) return [];

  try {
    const fetched = await channel.messages.fetch({ limit });
    return Array.from(fetched.values())
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map(message => ({
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        content: message.content,
        timestamp: new Date(message.createdTimestamp).toISOString(),
        attachments: Array.from(message.attachments.values()).map(formatAttachment)
      }));
  } catch {
    return [];
  }
}

function setPrivateLink(state: BridgeState, userId: string, channelId: string): BridgeState {
  return {
    ...state,
    private: {
      ownerUserId: userId,
      dmChannelId: channelId,
      linkedAt: Date.now()
    }
  };
}

function resetPrivateLink(state: BridgeState): BridgeState {
  return {
    ...state,
    private: {
      ownerUserId: null,
      dmChannelId: null,
      linkedAt: null
    },
    recentMessageIds: []
  };
}

async function buildDiscordRequestFromMessage(config: BridgeConfig, state: BridgeState, message: Message, promptContent = message.content): Promise<DiscordRelayRequest> {
  const attachments = getMessageAttachments(message);
  const contextMessages = message.channelId === state.private.dmChannelId ? [] : await collectChannelContext(message.channel, config.contextMessageCount);
  const replyTarget = buildReplyTarget(message.channelId, isDmMessage(message) ? "Direct message" : getChannelLabel(message.channel), isDmMessage(message) ? "dm" : "guild");

  return {
    bridgeRequestId: randomUUID(),
    discordUserId: message.author.id,
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    mode: isDmMessage(message) ? "dm" : "guild",
    prompt: promptContent,
    replyTarget,
    attachments,
    contextMessages
  };
}

function createSlashCommand() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Send a message to Poke.");

  command
    .addSubcommand(subcommand => subcommand
      .setName("send")
      .setDescription("Send a message to Poke.")
      .addStringOption(option => option
        .setName("message")
        .setDescription("The message to send to Poke.")
        .setRequired(true))
      .addAttachmentOption(option => option.setName("attachment1").setDescription("Optional attachment.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment2").setDescription("Optional attachment 2.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment3").setDescription("Optional attachment 3.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment4").setDescription("Optional attachment 4.").setRequired(false))
      .addAttachmentOption(option => option.setName("attachment5").setDescription("Optional attachment 5.").setRequired(false)))
    .addSubcommand(subcommand => subcommand
      .setName("setup")
      .setDescription("Enable Poke in this server channel.")
      .addChannelOption(option => option
        .setName("channel")
        .setDescription("Channel to enable. Defaults to the current channel.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)))
    .addSubcommand(subcommand => subcommand
      .setName("status")
      .setDescription("Show the current bridge status."))
    .addSubcommand(subcommand => subcommand
      .setName("reset")
      .setDescription("Reset the current bridge link or server installation."));

  return command.setContexts([InteractionContextType.Guild]).setIntegrationTypes([ApplicationIntegrationType.GuildInstall]).setDMPermission(false);
}

async function registerCommands(client: Client): Promise<void> {
  const application = await client.application?.fetch();
  if (!application) return;
  await application.commands.set([createSlashCommand()]);
}

function canManageGuildInstallation(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.inGuild()) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  return interaction.memberPermissions?.has("Administrator") ?? false;
}

function formatGuildInstallationStatus(state: BridgeState, guildId: string): string {
  const installation = state.guildInstallations[guildId];
  if (!installation) return "This server is not set up yet.";
  if (!installation.allowedChannelIds.length) return "This server is installed, but no channels are enabled.";
  return `Enabled in ${installation.allowedChannelIds.map(channelId => `<#${channelId}>`).join(", ")}.`;
}

export async function startDiscordBot(
  config: BridgeConfig,
  state: BridgeState,
  updateState: (next: BridgeState) => Promise<void>,
  onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>
): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel]
  });

  client.on("messageCreate", async message => {
    if (message.author.bot) return;

    if (message.guildId == null) {
      if (config.bridgeMode === "public") {
        const command = readCommand(message.content);
        if (command === "status") {
          await message.channel.send("This bot is running in public mode. Use /poke setup in a server to enable it.");
        }
        return;
      }

      const command = readCommand(message.content);
      if (command === "status") {
        await message.channel.send(state.private.ownerUserId ? `Linked to <@${state.private.ownerUserId}>.` : "Not linked yet.");
        return;
      }
      if (command === "reset") {
        Object.assign(state, resetPrivateLink(state));
        await updateState(state);
        await message.channel.send("Bridge reset.");
        return;
      }
      if (state.private.ownerUserId == null) {
        const linked = setPrivateLink(state, message.author.id, message.channel.id);
        Object.assign(state, linked);
        await updateState(state);
      }
      if (state.private.ownerUserId !== message.author.id) return;
      if (state.private.dmChannelId !== message.channel.id) {
        state.private.dmChannelId = message.channel.id;
        await updateState(state);
      }
    } else {
      const botUserId = client.user?.id;
      if (!botUserId) return;

      if (config.bridgeMode === "public") {
        if (!isGuildChannelAllowed(state, message.guildId, message.channelId)) return;
      }

      const mentioned = message.mentions.users.has(botUserId);
      const repliedToBot = await isReplyToBotMessage(message, botUserId);
      if (!mentioned && !repliedToBot) return;

      if (config.bridgeMode === "private" && state.private.ownerUserId != null && message.author.id !== state.private.ownerUserId) return;
    }

    if (state.recentMessageIds.includes(message.id)) return;
    Object.assign(state, rememberMessageId(state, message.id));
    await updateState(state);

    try {
      const botUserId = client.user?.id;
      const promptContent = message.guildId == null || !botUserId ? message.content : stripBotMentions(message.content, botUserId);
      const request = await buildDiscordRequestFromMessage(config, state, message, promptContent);
      request.prompt = buildDiscordRelayPrompt(request, config.bridgeMode);
      await onRelayRequest(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await message.channel.send(`Poke bridge failed: ${reason}`);
    }
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "setup") {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: "Use /poke setup in a server.", ephemeral: true });
        return;
      }
      if (config.bridgeMode !== "public") {
        await interaction.reply({ content: "Public setup is only available when the bridge runs in public mode.", ephemeral: true });
        return;
      }
      if (!canManageGuildInstallation(interaction)) {
        await interaction.reply({ content: "Only the server owner or an administrator can set this up.", ephemeral: true });
        return;
      }

      const channel = interaction.options.getChannel("channel");
      const targetChannelId = channel && typeof channel === "object" && "id" in channel ? channel.id : interaction.channelId;
      const nextState = installGuildChannel(state, interaction.guildId, interaction.user.id, targetChannelId);
      Object.assign(state, nextState);
      await updateState(state);
      await interaction.reply({ content: `Poke is now enabled in <#${targetChannelId}>.`, ephemeral: true });
      return;
    }

    if (subcommand === "status") {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: "Use /poke status in a server.", ephemeral: true });
        return;
      }

      if (config.bridgeMode === "public") {
        await interaction.reply({ content: formatGuildInstallationStatus(state, interaction.guildId), ephemeral: true });
        return;
      }

      const ownerLabel = state.private.ownerUserId ? `<@${state.private.ownerUserId}>` : "not linked yet";
      await interaction.reply({ content: `Private bridge linked to ${ownerLabel}.`, ephemeral: true });
      return;
    }

    if (subcommand === "reset") {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: "Use /poke reset in a server.", ephemeral: true });
        return;
      }

      if (config.bridgeMode === "public") {
        if (!canManageGuildInstallation(interaction)) {
          await interaction.reply({ content: "Only the server owner or an administrator can reset the installation.", ephemeral: true });
          return;
        }

        const nextState = removeGuildInstallation(state, interaction.guildId);
        Object.assign(state, nextState);
        await updateState(state);
        await interaction.reply({ content: "Server installation removed.", ephemeral: true });
        return;
      }

      if (state.private.ownerUserId == null) {
        await interaction.reply({ content: "This bridge is not linked yet.", ephemeral: true });
        return;
      }

      if (interaction.user.id !== state.private.ownerUserId) {
        await interaction.reply({ content: "This bridge is linked to another Discord account.", ephemeral: true });
        return;
      }

      Object.assign(state, resetPrivateLink(state));
      await updateState(state);
      await interaction.reply({ content: "Private bridge reset.", ephemeral: true });
      return;
    }

    if (subcommand !== "send") return;

    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Use /poke send in a server.", ephemeral: true });
      return;
    }

    if (config.bridgeMode === "public") {
      if (!isGuildChannelAllowed(state, interaction.guildId, interaction.channelId)) {
        await interaction.reply({ content: "This channel is not enabled for Poke yet.", ephemeral: true });
        return;
      }
    } else if (state.private.ownerUserId == null) {
      await interaction.reply({ content: "DM me first so I know which account to use.", ephemeral: true });
      return;
    } else if (interaction.user.id !== state.private.ownerUserId) {
      await interaction.reply({ content: "This bridge is linked to another Discord account.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const request = await buildDiscordRequestFromInteraction(config, interaction);
      request.prompt = buildDiscordRelayPrompt(request, config.bridgeMode);
      await onRelayRequest(request);
      await interaction.editReply("Sent to Poke.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Poke bridge failed: ${reason}`);
    }
  });

  client.once("clientReady", async () => {
    try {
      await registerCommands(client);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stdout.write(`[poke-discord-bridge] Command registration failed: ${reason}\n`);
    }
  });

  await client.login(config.discordToken);
  return client;
}

function isReactableMessage(message: unknown): message is { react: (emoji: string) => Promise<unknown>; } {
  return typeof message === "object" && message != null && "react" in message && typeof (message as { react?: unknown }).react === "function";
}

export async function sendDiscordMessage(client: Client, channelId: string, content: string, options: OutboundMessageOptions = {}): Promise<string[]> {
  const channel = await client.channels.fetch(channelId);
  if (!isSendableChannel(channel) || !channel.isTextBased()) {
    throw new Error("Discord channel not found.");
  }

  return sendChunks(channel, content, options);
}

export async function editDiscordMessage(client: Client, channelId: string, messageId: string, content?: string, embeds?: DiscordOutboundEmbed[]): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const message = await channel.messages.fetch(messageId);
  await message.edit({ content, ...(embeds?.length ? { embeds: embeds.map(buildEmbedBuilder) } : {}) });
}

export async function deleteDiscordMessage(client: Client, channelId: string, messageId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const message = await channel.messages.fetch(messageId);
  await message.delete();
}

export async function sendDiscordReaction(client: Client, channelId: string, messageId: string, emoji: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const message = await channel.messages.fetch(messageId);
  if (!isReactableMessage(message)) {
    throw new Error("Discord message cannot be reacted to.");
  }

  await message.react(emoji);
}

export async function startTypingIndicator(client: Client, channelId: string): Promise<() => Promise<void>> {
  const channel = await client.channels.fetch(channelId);
  if (!isTypingChannel(channel)) {
    throw new Error("Discord channel not found.");
  }

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await channel.sendTyping();
    } catch {
      // Ignore typing failures; they are best-effort only.
    }
  };

  await tick();
  const interval = setInterval(() => void tick(), 8000);

  return async () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function buildDiscordRequestFromInteraction(config: BridgeConfig, interaction: ChatInputCommandInteraction): Promise<DiscordRelayRequest> {
  const attachments = getCommandAttachments(interaction);
  const contextMessages = await collectChannelContext(interaction.channel, config.contextMessageCount);
  const replyTarget = buildReplyTarget(interaction.channelId, getChannelLabel(interaction.channel) ?? "Server channel", "guild");

  return {
    bridgeRequestId: randomUUID(),
    discordUserId: interaction.user.id,
    discordChannelId: interaction.channelId,
    discordMessageId: interaction.id,
    mode: "guild",
    prompt: interaction.options.getString("message", true),
    replyTarget,
    attachments,
    contextMessages
  };
}
