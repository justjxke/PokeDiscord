import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  AttachmentBuilder,
  ChannelType,
  Client,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  ModalBuilder,
  Partials,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction
} from "discord.js";

import {
  clearOwnerLink,
  clearUserLink,
  consumeGuildProactiveConversationTurn,
  getGuildProactiveConversationState,
  getGuildUnrestrictedReplyMode,
  installGuildChannel,
  isGuildChannelAllowed,
  isGuildProactiveRepliesAllowed,
  isGuildUnrestrictedRepliesAllowed,
  removeGuildInstallation,
  setGuildKey,
  setGuildChannelAccess,
  setGuildProactiveChannelOverride,
  setGuildProactiveReplyMode,
  setGuildUnrestrictedChannelOverride,
  setGuildUnrestrictedReplyMode,
  setOwnerLink,
  setUserLink,
  startGuildProactiveConversation
} from "./bridgePolicy";
import { downloadAttachmentBuffer } from "./attachmentFetch";
import { buildDiscordRelayPrompt } from "./prompt";
import { createVoiceManager, type VoiceManager } from "./voice";
import { encryptTenantSecret } from "./tenantSecrets";
import { rememberMessageId, type BridgeState } from "./state";
import type {
  BridgeConfig,
  DiscordAttachmentContext,
  DiscordChannelHistoryMessage,
  DiscordChannelHistoryPage,
  DiscordMessageContext,
  DiscordOutboundAttachment,
  DiscordOutboundEmbed,
  DiscordReplyTarget,
  DiscordRelayRequest,
  DiscordVoiceContext,
  PokeSendResult,
  TenantReference
} from "./types";

const SERVER_ATTACHMENT_OPTION_COUNT = 5;
const COMMAND_NAME = "poke";
const COMMAND_PREFIX = "!";
const DM_KEY_REGEX = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DM_SETUP_MODAL_PREFIX = "poke-dm-setup";
const GUILD_SETUP_MODAL_PREFIX = "poke-guild-setup";
const PROACTIVE_THREAD_TURNS = 2;
const PROACTIVE_THREAD_WINDOW_MS = 10 * 60 * 1000;
const PROACTIVE_CONTEXT_WINDOW_MS = 15 * 60 * 1000;
const PROACTIVE_CONTEXT_RECENT_MESSAGE_LIMIT = 8;
const POKE_CALL_OUT_PATTERN = /^\s*poke\b[,!:\-\s]*/i;
const POKE_INLINE_PATTERN = /\bpoke\b[,!:\-\s]*/i;
const QUESTION_INTENT_PATTERN = /(?:\?|^(?:can|could|would|should|do|does|did|is|are|am|was|were|will|may|might|what|why|how|who|where|when)\b|\b(?:anyone|someone|help|know|think)\b)/i;
const FOLLOW_UP_INTENT_PATTERN = /^(?:and|also|so|then|okay|ok|cool|right|wait|what about|how about|why|how|can you|could you|would you|should you)\b/i;
const DISABLE_INTENT_PATTERN = /\b(?:stop|disable|turn off|quiet|mute|shut up|don't reply|do not reply|no more replies)\b/i;
const SETTINGS_MODAL_PREFIX = "poke-settings";

type SettingsSection = "overview" | "account" | "guild" | "proactive" | "danger";

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

function formatChannelHistoryAttachment(attachment: { url: string; name: string; contentType?: string | null; }): { url: string; name: string; contentType: string | null; } {
  return {
    url: attachment.url,
    name: attachment.name,
    contentType: attachment.contentType ?? null
  };
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
    const buffer = await downloadAttachmentBuffer(attachment.url, {
      timeoutMs: 10_000,
      maxBytes: 8 * 1024 * 1024
    });
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
  userId?: string;
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

async function sendTextMessage(channel: Message["channel"] | ChatInputCommandInteraction["channel"], content: string): Promise<void> {
  if (!isSendableChannel(channel) || !channel.isTextBased()) {
    throw new Error("Discord channel not found.");
  }

  await channel.send(content);
}

async function resolveSendTargetChannel(client: Client, channelId: string, fallbackUserId?: string): Promise<{ send: (content: string | { content?: string; reply?: { messageReference: string; failIfNotExists: boolean; }; files?: AttachmentBuilder[]; embeds?: EmbedBuilder[]; }) => Promise<{ id: string }>; }> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (isSendableChannel(channel) && channel.isTextBased()) {
      return channel;
    }
  } catch {
    // Try DM fallback below.
  }

  if (fallbackUserId) {
    try {
      const user = await client.users.fetch(fallbackUserId);
      const dmChannel = await user.createDM();
      if (isSendableChannel(dmChannel) && dmChannel.isTextBased()) {
        return dmChannel;
      }
    } catch {
      // Fall through to the generic error below.
    }
  }

  throw new Error("Discord channel not found.");
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

function stripLeadingPokeCallout(content: string): string {
  return content.replace(POKE_CALL_OUT_PATTERN, "").trim();
}

function normalizeGuildMessageText(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

function containsQuestionIntent(content: string): boolean {
  return QUESTION_INTENT_PATTERN.test(normalizeGuildMessageText(content));
}

function containsFollowUpIntent(content: string): boolean {
  return FOLLOW_UP_INTENT_PATTERN.test(normalizeGuildMessageText(content));
}

function isDisableRequest(content: string): boolean {
  return DISABLE_INTENT_PATTERN.test(normalizeGuildMessageText(content));
}

function isPokeCallout(content: string): boolean {
  return POKE_CALL_OUT_PATTERN.test(content) || POKE_INLINE_PATTERN.test(content);
}

const TOPIC_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "what", "about", "can", "could", "would", "should",
  "you", "your", "are", "is", "was", "were", "be", "to", "of", "in", "on", "it", "me", "we",
  "they", "them", "i", "a", "an", "or", "if", "at", "as", "do", "did", "does", "help", "think",
  "know", "please", "yeah", "yes", "no", "ok", "okay", "right", "then", "so", "and", "also", "why",
  "how", "who", "when", "where", "can", "could", "would", "should", "anyone", "someone"
]);

function normalizeTopicText(content: string): string {
  return content.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function extractTopicTokens(content: string): string[] {
  return normalizeTopicText(content)
    .split(" ")
    .map(token => token.trim())
    .filter(token => token.length > 2 && !TOPIC_STOP_WORDS.has(token));
}

function collectTopicTokens(messages: DiscordMessageContext[]): Set<string> {
  const tokens = new Set<string>();
  for (const message of messages) {
    for (const token of extractTopicTokens(message.content)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function similarityScore(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.max(left.size, right.size);
}

function hasRecentPokeReference(messages: DiscordMessageContext[], botUserId: string): boolean {
  return messages.some(message => message.authorId === botUserId || isPokeCallout(message.content));
}

function assessContextSignal(options: {
  content: string;
  messageTimestamp?: string;
  channelContext?: DiscordMessageContext[];
  botUserId?: string;
}): { score: number; topicShift: boolean; } {
  const context = options.channelContext?.slice(-PROACTIVE_CONTEXT_RECENT_MESSAGE_LIMIT) ?? [];
  const history = context.slice(0, -1);
  if (!history.length || !options.botUserId) return { score: 0, topicShift: false };

  const currentAt = options.messageTimestamp ? Date.parse(options.messageTimestamp) : Date.now();
  const lastBotIndex = [...history].reverse().findIndex(message => message.authorId === options.botUserId);
  if (lastBotIndex === -1) return { score: 0, topicShift: false };

  const lastBotMessage = history[history.length - 1 - lastBotIndex];
  const lastBotAt = Date.parse(lastBotMessage.timestamp);
  const timeSinceLastBot = currentAt - lastBotAt;
  if (!Number.isFinite(timeSinceLastBot) || timeSinceLastBot < 0) return { score: 0, topicShift: false };

  const messagesAfterBot = history.slice(history.length - lastBotIndex);
  if (!messagesAfterBot.length) return { score: 0, topicShift: false };

  const recentWindow = currentAt - Date.parse(messagesAfterBot[0]?.timestamp ?? lastBotMessage.timestamp);
  const currentTokens = new Set(extractTopicTokens(options.content));
  const contextTokens = collectTopicTokens(messagesAfterBot.filter(message => message.authorId !== options.botUserId));
  const overlap = similarityScore(currentTokens, contextTokens);
  const followUpIntent = containsFollowUpIntent(options.content);
  const questionIntent = containsQuestionIntent(options.content);
  const pokeReferenced = hasRecentPokeReference(messagesAfterBot, options.botUserId);

  let score = 0;
  if (timeSinceLastBot <= PROACTIVE_CONTEXT_WINDOW_MS) score += 2;
  if (recentWindow <= PROACTIVE_CONTEXT_WINDOW_MS / 2) score += 1;
  if (overlap >= 0.2) score += 1.5;
  if (followUpIntent) score += 1;
  if (questionIntent) score += 1;
  if (pokeReferenced) score += 0.5;

  const topicShift = messagesAfterBot.length >= 3 && overlap < 0.12 && !pokeReferenced && !followUpIntent;
  if (topicShift) score -= 2.5;
  if (timeSinceLastBot > PROACTIVE_CONTEXT_WINDOW_MS) score -= 1.5;

  return { score, topicShift };
}

export interface GuildProactiveReplyDecision {
  shouldRelay: boolean;
  startConversation: boolean;
  consumeConversation: boolean;
  promptContent: string;
  reason: "direct" | "proactive" | "followup" | "none";
}

export function evaluateGuildProactiveReply(options: {
  content: string;
  mentioned: boolean;
  repliedToBot: boolean;
  proactiveAllowed: boolean;
  activeConversation: { activeUntil: number; turnsLeft: number; } | null;
  channelContext?: DiscordMessageContext[];
  botUserId?: string;
  messageTimestamp?: string;
}): GuildProactiveReplyDecision {
  const content = options.content;
  const questionIntent = containsQuestionIntent(content);
  const followUpIntent = containsFollowUpIntent(content);
  const inConversation = Boolean(options.activeConversation && options.activeConversation.activeUntil > Date.now() && options.activeConversation.turnsLeft > 0);
  const explicitCallout = isPokeCallout(content);
  const contextSignal = assessContextSignal({
    content,
    messageTimestamp: options.messageTimestamp,
    channelContext: options.channelContext,
    botUserId: options.botUserId
  });

  if (options.mentioned || options.repliedToBot) {
    return {
      shouldRelay: true,
      startConversation: true,
      consumeConversation: false,
      promptContent: content.trim(),
      reason: "direct"
    };
  }

  if (inConversation && questionIntent && followUpIntent) {
    return {
      shouldRelay: true,
      startConversation: false,
      consumeConversation: true,
      promptContent: stripLeadingPokeCallout(content),
      reason: "followup"
    };
  }

  if (options.proactiveAllowed && explicitCallout && questionIntent) {
    return {
      shouldRelay: true,
      startConversation: true,
      consumeConversation: false,
      promptContent: stripLeadingPokeCallout(content),
      reason: "proactive"
    };
  }

  if (options.proactiveAllowed && !explicitCallout && !contextSignal.topicShift && questionIntent && contextSignal.score >= 4) {
    return {
      shouldRelay: true,
      startConversation: true,
      consumeConversation: false,
      promptContent: content.trim(),
      reason: contextSignal.topicShift ? "none" : "proactive"
    };
  }

  return {
    shouldRelay: false,
    startConversation: false,
    consumeConversation: false,
    promptContent: content,
    reason: "none"
  };
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

function buildVoiceContext(
  voiceManager: VoiceManager,
  guild: Message["guild"] | ChatInputCommandInteraction["guild"] | null | undefined,
  requesterId: string,
  requesterUsername: string,
  requesterDisplayName: string
): DiscordVoiceContext | null {
  if (!guild) return null;

  return voiceManager.describeVoiceContext(guild.id, {
    userId: requesterId,
    username: requesterUsername,
    displayName: requesterDisplayName
  });
}

function getInteractionDisplayName(interaction: ChatInputCommandInteraction): string {
  if (interaction.inGuild() && interaction.member && "displayName" in interaction.member && typeof interaction.member.displayName === "string") {
    return interaction.member.displayName;
  }

  return interaction.user.globalName ?? interaction.user.username;
}

export async function getDiscordChannelHistory(
  client: Client,
  channelId: string,
  options: { limit?: number; beforeMessageId?: string; afterMessageId?: string } = {}
): Promise<DiscordChannelHistoryPage> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be between 1 and 100");
  }

  if (options.beforeMessageId && options.afterMessageId) {
    throw new Error("beforeMessageId and afterMessageId cannot be used together");
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    throw new Error("Discord channel not found.");
  }

  const fetched = await channel.messages.fetch({
    limit,
    ...(options.beforeMessageId ? { before: options.beforeMessageId } : {}),
    ...(options.afterMessageId ? { after: options.afterMessageId } : {})
  });

  const messages = Array.from(fetched.values())
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map(message => ({
      id: message.id,
      content: message.content,
      author: message.author.username,
      timestamp: new Date(message.createdTimestamp).toISOString(),
      isReply: message.reference != null,
      attachments: Array.from(message.attachments.values()).map(formatChannelHistoryAttachment)
    }));

  const nextBeforeMessageId = messages[0]?.id ?? null;
  const nextAfterMessageId = messages[messages.length - 1]?.id ?? null;

  return {
    messages,
    nextBeforeMessageId,
    nextAfterMessageId,
    hasMoreBefore: options.afterMessageId ? messages.length > 0 : messages.length === limit,
    hasMoreAfter: options.beforeMessageId ? true : options.afterMessageId ? messages.length === limit : false
  };
}

function isLikelyPokeApiKey(value: string): boolean {
  return DM_KEY_REGEX.test(value.trim());
}

function getTenantForDm(config: BridgeConfig, authorId: string): TenantReference {
  if (config.ownerDiscordUserId && config.ownerDiscordUserId === authorId) {
    return { kind: "owner", id: authorId };
  }

  return { kind: "user", id: authorId };
}

function getTenantForGuild(guildId: string): TenantReference {
  return { kind: "guild", id: guildId };
}

function buildSetupModal(customId: string, title: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);

  const apiKeyInput = new TextInputBuilder()
    .setCustomId("apiKey")
    .setLabel("Poke API key")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(8);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput));
  return modal;
}

export function buildGuildSetupModal(guildId: string, channelId: string, userId: string): ModalBuilder {
  return buildSetupModal(`${GUILD_SETUP_MODAL_PREFIX}:${guildId}:${channelId}:${userId}`, "Link Poke to this server");
}

export function buildDmSetupModal(userId: string): ModalBuilder {
  return buildSetupModal(`${DM_SETUP_MODAL_PREFIX}:${userId}`, "Link Poke to this account");
}

export function parseGuildSetupModal(customId: string): { guildId: string; channelId: string; userId: string; } | null {
  if (!customId.startsWith(`${GUILD_SETUP_MODAL_PREFIX}:`)) return null;
  const [, guildId, channelId, userId] = customId.split(":", 4);
  if (!guildId || !channelId || !userId) return null;
  return { guildId, channelId, userId };
}

export function parseDmSetupModal(customId: string): { userId: string; } | null {
  if (!customId.startsWith(`${DM_SETUP_MODAL_PREFIX}:`)) return null;
  const [, userId] = customId.split(":", 2);
  if (!userId) return null;
  return { userId };
}

type SettingsPanelAction =
  | "switch"
  | "link-dm"
  | "reset-dm"
  | "link-guild"
  | "enable-channel"
  | "disable-channel"
  | "toggle-unrestricted-default"
  | "enable-unrestricted-here"
  | "disable-unrestricted-here"
  | "clear-unrestricted-override"
  | "toggle-proactive-default"
  | "enable-proactive-here"
  | "disable-proactive-here"
  | "clear-proactive-override"
  | "reset-guild";

interface SettingsPanelInteraction {
  section: SettingsSection;
  action: SettingsPanelAction;
  targetChannelId: string | null;
}

interface SettingsPanelContext {
  inGuild(): boolean;
  guildId: string | null;
  channelId: string;
}

function buildSettingsCustomId(section: SettingsSection, action: SettingsPanelAction, targetChannelId: string | null): string {
  return `${SETTINGS_MODAL_PREFIX}:${section}:${action}:${targetChannelId ?? ""}`;
}

function parseSettingsCustomId(customId: string): SettingsPanelInteraction | null {
  if (!customId.startsWith(`${SETTINGS_MODAL_PREFIX}:`)) return null;
  const [, section, action, targetChannelId] = customId.split(":", 4);
  if (!section || !action) return null;
  if (section !== "overview" && section !== "account" && section !== "guild" && section !== "proactive" && section !== "danger") return null;
  if (action !== "switch"
    && action !== "link-dm"
    && action !== "reset-dm"
    && action !== "link-guild"
    && action !== "enable-channel"
    && action !== "disable-channel"
    && action !== "toggle-unrestricted-default"
    && action !== "enable-unrestricted-here"
    && action !== "disable-unrestricted-here"
    && action !== "clear-unrestricted-override"
    && action !== "toggle-proactive-default"
    && action !== "enable-proactive-here"
    && action !== "disable-proactive-here"
    && action !== "clear-proactive-override"
    && action !== "reset-guild") {
    return null;
  }

  return {
    section: section as SettingsSection,
    action: action as SettingsPanelAction,
    targetChannelId: targetChannelId?.length ? targetChannelId : null
  };
}

function getSettingsTargetChannelLabel(targetChannelId: string | null): string {
  return targetChannelId ? `<#${targetChannelId}>` : "this channel";
}

function getSettingsTargetChannelId(interaction: ChatInputCommandInteraction, fallbackChannelId: string | null): string | null {
  const channel = interaction.options.getChannel("channel");
  const optionChannelId = channel && typeof channel === "object" && "id" in channel ? channel.id : null;
  return optionChannelId ?? fallbackChannelId ?? interaction.channelId ?? null;
}

function canEditDmSettings(interaction: { user: { id: string; }; }, tenant: TenantReference): boolean {
  return interaction.user.id === tenant.id;
}

function buildSettingsSectionOrder(isGuildContext: boolean): SettingsSection[] {
  return isGuildContext
    ? ["overview", "guild", "proactive", "danger"]
    : ["overview", "account", "danger"];
}

function buildSettingsSectionTitle(section: SettingsSection): string {
  switch (section) {
    case "overview":
      return "Overview";
    case "account":
      return "Account";
    case "guild":
      return "Guild";
    case "proactive":
      return "Proactive";
    case "danger":
      return "Danger Zone";
  }
}

function buildSettingsOverviewDescription(context: SettingsPanelContext, tenant: TenantReference, targetChannelId: string | null): string {
  if (context.inGuild()) {
    return [
      "Server settings are managed here.",
      `Target channel: ${getSettingsTargetChannelLabel(targetChannelId)}.`,
      "Use the Guild and Proactive sections to change server defaults or the selected channel.",
      "The Danger Zone contains irreversible actions."
    ].join(" ");
  }

  if (tenant.kind === "owner") {
    return "This is the owner DM settings panel. Use it to manage the owner link or reset it.";
  }

  return "This is your personal DM settings panel. Use it to manage your linked account or reset it.";
}

function buildSettingsOverviewFieldValue(state: BridgeState, tenant: TenantReference, config: BridgeConfig, context: SettingsPanelContext, targetChannelId: string | null): string {
  if (!context.inGuild()) {
    return formatTenantStatus(state, tenant, config);
  }

  const guildId = context.guildId;
  if (!guildId) return "This server is not set up yet.";
  const installation = state.guildInstallations[guildId];
  if (!installation) return "This server is not set up yet.";
  const channelId = targetChannelId ?? context.channelId;
  const channelLabel = getSettingsTargetChannelLabel(channelId);
  const channelEnabled = isGuildChannelAllowed(state, guildId, channelId);
  const unrestrictedMode = isGuildUnrestrictedRepliesAllowed(state, guildId, channelId);
  const proactiveMode = isGuildProactiveRepliesAllowed(state, guildId, channelId);
  const unrestrictedDisplay = installation.guildUnrestrictedChannelOverrides[channelId] == null
    ? (installation.guildUnrestrictedRepliesEnabled ? "inherit (enabled)" : "inherit (disabled)")
    : (installation.guildUnrestrictedChannelOverrides[channelId] ? "enabled" : "disabled");
  const proactiveDisplay = installation.proactiveChannelOverrides[channelId] == null
    ? (installation.proactiveRepliesEnabled ? "inherit (enabled)" : "inherit (disabled)")
    : (installation.proactiveChannelOverrides[channelId] ? "enabled" : "disabled");
  return [
    `Channel access for ${channelLabel}: ${channelEnabled ? "enabled" : "disabled"}.`,
    `Unrestricted mode for ${channelLabel}: ${unrestrictedDisplay} (${unrestrictedMode ? "active" : "inactive"}).`,
    `Proactive replies for ${channelLabel}: ${proactiveDisplay} (${proactiveMode ? "active" : "inactive"}).`
  ].join(" ");
}

function buildSettingsPanelEmbed(state: BridgeState, tenant: TenantReference, config: BridgeConfig, context: SettingsPanelContext, section: SettingsSection, targetChannelId: string | null): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Poke Settings · ${buildSettingsSectionTitle(section)}`)
    .setDescription(buildSettingsOverviewDescription(context, tenant, targetChannelId))
    .setColor(context.inGuild() ? 0x5865f2 : 0x2ecc71);

  embed.addFields({
    name: "Status",
    value: buildSettingsOverviewFieldValue(state, tenant, config, context, targetChannelId)
  });

  if (context.inGuild()) {
    const guildId = context.guildId;
    const installation = guildId ? state.guildInstallations[guildId] : null;
    if (installation) {
      embed.addFields(
        {
          name: "Guild Default",
          value: [
            `Unrestricted: ${installation.guildUnrestrictedRepliesEnabled ? "on" : "off"}`,
            `Proactive: ${installation.proactiveRepliesEnabled ? "on" : "off"}`
          ].join("\n")
        },
        {
          name: "Enabled Channels",
          value: installation.allowedChannelIds.length
            ? installation.allowedChannelIds.map(channelId => `<#${channelId}>`).join(", ")
            : "None"
        },
        {
          name: "Warning",
          value: "Unrestricted mode relaxes the guild privacy guardrails. Only enable it in a trusted private server."
        }
      );
    }
  }

  return embed;
}

function buildSettingsPanelComponents(state: BridgeState, tenant: TenantReference, context: SettingsPanelContext, section: SettingsSection, targetChannelId: string | null): ActionRowBuilder<ButtonBuilder>[] {
  const isGuildContext = context.inGuild();
  const tabs = buildSettingsSectionOrder(isGuildContext);
  const tabRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...tabs.map(tab => new ButtonBuilder()
      .setCustomId(buildSettingsCustomId(tab, "switch", targetChannelId))
      .setLabel(buildSettingsSectionTitle(tab))
      .setStyle(tab === "danger" ? ButtonStyle.Danger : (tab === section ? ButtonStyle.Primary : ButtonStyle.Secondary))
      .setDisabled(isGuildContext ? tab === "account" : tab !== "overview" && tab !== "account" && tab !== "danger"))
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [tabRow];

  if (context.inGuild()) {
    const guildId = context.guildId;
    const installation = guildId ? state.guildInstallations[guildId] : null;
    const currentChannelId = targetChannelId ?? context.channelId;
    const channelAllowed = guildId ? isGuildChannelAllowed(state, guildId, currentChannelId) : false;
    const channelExplicitlyAllowed = Boolean(installation?.allowedChannelIds.includes(currentChannelId));
    const unrestrictedMode = guildId ? isGuildUnrestrictedRepliesAllowed(state, guildId, currentChannelId) : false;
    const unrestrictedOverride = installation ? installation.guildUnrestrictedChannelOverrides[currentChannelId] : undefined;
    const proactiveAllowed = guildId ? isGuildProactiveRepliesAllowed(state, guildId, currentChannelId) : false;
    const proactiveOverride = installation ? installation.proactiveChannelOverrides[currentChannelId] : undefined;

    if (section === "guild") {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "link-guild", currentChannelId))
          .setLabel(installation ? "Re-link server" : "Set up server")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "enable-channel", currentChannelId))
          .setLabel("Enable this channel")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!installation || channelExplicitlyAllowed),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "disable-channel", currentChannelId))
          .setLabel("Disable this channel")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!installation || !channelExplicitlyAllowed),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "toggle-unrestricted-default", currentChannelId))
          .setLabel(installation?.guildUnrestrictedRepliesEnabled ? "Turn unrestricted off" : "Turn unrestricted on")
          .setStyle(installation?.guildUnrestrictedRepliesEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
          .setDisabled(!installation)
      ));
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "enable-unrestricted-here", currentChannelId))
          .setLabel("Enable unrestricted here")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!installation),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "disable-unrestricted-here", currentChannelId))
          .setLabel("Disable unrestricted here")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!installation),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "clear-unrestricted-override", currentChannelId))
          .setLabel("Use server default")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!installation || unrestrictedOverride == null)
      ));
    }

    if (section === "proactive") {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "toggle-proactive-default", currentChannelId))
          .setLabel(installation?.proactiveRepliesEnabled ? "Turn proactive off" : "Turn proactive on")
          .setStyle(installation?.proactiveRepliesEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
          .setDisabled(!installation),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "enable-proactive-here", currentChannelId))
          .setLabel("Enable here")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!installation || (proactiveAllowed === true && proactiveOverride == null)),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "disable-proactive-here", currentChannelId))
          .setLabel("Disable here")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!installation || (proactiveAllowed === false && proactiveOverride == null)),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "clear-proactive-override", currentChannelId))
          .setLabel("Use server default")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!installation || proactiveOverride == null)
      ));
    }

    if (section === "danger") {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId(section, "reset-guild", currentChannelId))
          .setLabel("Reset server installation")
          .setStyle(ButtonStyle.Danger)
      ));
    }

  } else {
    if (section === "account" || section === "overview") {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId("account", "link-dm", null))
          .setLabel(tenant.kind === "owner" ? "Link owner account" : "Link account")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId("account", "reset-dm", null))
          .setLabel("Reset link")
          .setStyle(ButtonStyle.Danger)
      ));
    }

    if (section === "danger") {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSettingsCustomId("danger", "reset-dm", null))
          .setLabel("Reset link")
          .setStyle(ButtonStyle.Danger)
      ));
    }
  }

  return rows;
}

function buildSettingsPanel(state: BridgeState, tenant: TenantReference, config: BridgeConfig, context: SettingsPanelContext, section: SettingsSection, targetChannelId: string | null): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[]; } {
  return {
    embeds: [buildSettingsPanelEmbed(state, tenant, config, context, section, targetChannelId)],
    components: buildSettingsPanelComponents(state, tenant, context, section, targetChannelId)
  };
}

function canManageGuildInstallation(interaction: {
  inGuild(): boolean;
  guild?: { ownerId?: string | null; } | null;
  user: { id: string; };
  memberPermissions?: { has(permission: unknown, checkAdmin?: boolean): boolean; } | null;
}): boolean {
  if (!interaction.inGuild()) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  return interaction.memberPermissions?.has("Administrator") ?? false;
}

function formatOwnerStatus(state: BridgeState, config: BridgeConfig): string {
  const ownerLabel = config.ownerDiscordUserId ? `<@${config.ownerDiscordUserId}>` : "not configured";
  const linked = state.owner.encryptedPokeApiKey ? "linked" : "not linked";
  return `Owner namespace: ${ownerLabel} (${linked}).`;
}

function formatUserStatus(state: BridgeState): string {
  const count = Object.keys(state.users).length;
  return count ? `${count} linked user account${count === 1 ? "" : "s"}.` : "No linked user accounts yet.";
}

function formatGuildInstallationStatus(state: BridgeState, guildId: string): string {
  const installation = state.guildInstallations[guildId];
  if (!installation) return "This server is not set up yet.";
  if (!installation.allowedChannelIds.length) return "This server is installed, but no channels are enabled.";
  return `Enabled in ${installation.allowedChannelIds.map(channelId => `<#${channelId}>`).join(", ")}.`;
}

function formatGuildProactiveStatus(state: BridgeState, guildId: string, channelId?: string): string {
  const installation = state.guildInstallations[guildId];
  if (!installation) return "This server is not set up yet.";

  if (channelId) {
    const mode = installation.proactiveChannelOverrides[channelId] == null
      ? (installation.proactiveRepliesEnabled ? "inherit (enabled)" : "inherit (disabled)")
      : (installation.proactiveChannelOverrides[channelId] ? "enabled" : "disabled");
    const conversation = installation.proactiveConversationState[channelId];
    const window = conversation && conversation.activeUntil > Date.now() && conversation.turnsLeft > 0
      ? `, short thread active (${conversation.turnsLeft} turn${conversation.turnsLeft === 1 ? "" : "s"} left)`
      : "";
    return `Proactive replies for <#${channelId}>: ${mode}${window}.`;
  }

  const overrideCount = Object.keys(installation.proactiveChannelOverrides).length;
  const enabled = installation.proactiveRepliesEnabled ? "on" : "off";
  return `Proactive replies are ${enabled} for this server${overrideCount ? `, with ${overrideCount} channel override${overrideCount === 1 ? "" : "s"}` : ""}.`;
}

function formatTenantStatus(state: BridgeState, tenant: TenantReference, config: BridgeConfig): string {
  if (tenant.kind === "owner") return formatOwnerStatus(state, config);
  if (tenant.kind === "user") {
    const user = state.users[tenant.id];
    return user?.encryptedPokeApiKey ? `Linked to <@${tenant.id}>.` : `Not linked yet for <@${tenant.id}>.`;
  }

  const installation = state.guildInstallations[tenant.id];
  if (!installation) return "This server is not set up yet.";
  return formatGuildInstallationStatus(state, tenant.id);
}

function getTenantSecretState(state: BridgeState, tenant: TenantReference) {
  if (tenant.kind === "owner") return state.owner;
  if (tenant.kind === "user") return state.users[tenant.id] ?? null;
  return state.guildInstallations[tenant.id] ?? null;
}

export function buildSetupLinkedMessage(state: BridgeState, tenant: TenantReference, config: BridgeConfig): string {
  const status = formatTenantStatus(state, tenant, config);
  return `${status} Open /poke settings if you want the full view or to relink.`;
}

export function isTenantLinked(state: BridgeState, tenant: TenantReference): boolean {
  const tenantSecret = getTenantSecretState(state, tenant);
  return Boolean(tenantSecret?.encryptedPokeApiKey);
}

function setTenantSecretState(state: BridgeState, tenant: TenantReference, encryptedPokeApiKey: ReturnType<typeof encryptTenantSecret>, discordUserId: string, dmChannelId: string): BridgeState {
  if (tenant.kind === "owner") {
    return setOwnerLink(state, discordUserId, dmChannelId, encryptedPokeApiKey);
  }

  if (tenant.kind === "user") {
    return setUserLink(state, discordUserId, dmChannelId, encryptedPokeApiKey);
  }

  const nextState = setGuildKey(state, tenant.id, discordUserId, encryptedPokeApiKey);
  return installGuildChannel(nextState, tenant.id, discordUserId, dmChannelId, encryptedPokeApiKey);
}

async function buildDiscordRequestFromMessage(
  config: BridgeConfig,
  state: BridgeState,
  message: Message,
  tenant: TenantReference,
  voiceManager: VoiceManager,
  promptContent = message.content,
  contextMessagesOverride?: DiscordMessageContext[]
): Promise<DiscordRelayRequest> {
  const attachments = getMessageAttachments(message);
  const contextMessages = contextMessagesOverride ?? (message.guildId == null ? [] : await collectChannelContext(message.channel, config.contextMessageCount));
  const replyTarget = buildReplyTarget(message.channelId, isDmMessage(message) ? "Direct message" : getChannelLabel(message.channel), isDmMessage(message) ? "dm" : "guild");
  const guildUnrestrictedRepliesEnabled = message.guildId ? isGuildUnrestrictedRepliesAllowed(state, message.guildId, message.channelId) : false;

  return {
    bridgeRequestId: randomUUID(),
    tenant,
    discordUserId: message.author.id,
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    mode: isDmMessage(message) ? "dm" : "guild",
    prompt: promptContent,
    replyTarget,
    guildUnrestrictedRepliesEnabled,
    attachments,
    contextMessages,
    voiceContext: buildVoiceContext(
      voiceManager,
      message.guild,
      message.author.id,
      message.author.username,
      message.member?.displayName ?? message.author.globalName ?? message.author.username
    )
  };
}

async function buildDiscordRequestFromInteraction(
  config: BridgeConfig,
  state: BridgeState,
  interaction: ChatInputCommandInteraction,
  tenant: TenantReference,
  voiceManager: VoiceManager
): Promise<DiscordRelayRequest> {
  const attachments = getCommandAttachments(interaction);
  const contextMessages = interaction.inGuild() ? await collectChannelContext(interaction.channel, config.contextMessageCount) : [];
  const replyTarget = buildReplyTarget(interaction.channelId, getChannelLabel(interaction.channel) ?? (interaction.inGuild() ? "Server channel" : "Direct message"), interaction.inGuild() ? "guild" : "dm");
  const guildUnrestrictedRepliesEnabled = interaction.inGuild() ? isGuildUnrestrictedRepliesAllowed(state, interaction.guildId, interaction.channelId) : false;

  return {
    bridgeRequestId: randomUUID(),
    tenant,
    discordUserId: interaction.user.id,
    discordChannelId: interaction.channelId,
    discordMessageId: interaction.id,
    mode: interaction.inGuild() ? "guild" : "dm",
    prompt: interaction.options.getString("message", true),
    replyTarget,
    guildUnrestrictedRepliesEnabled,
    attachments,
    contextMessages,
    voiceContext: buildVoiceContext(
      voiceManager,
      interaction.guild,
      interaction.user.id,
      interaction.user.username,
      getInteractionDisplayName(interaction)
    )
  };
}

async function respond(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(content);
    return;
  }

  await interaction.reply({ content, ephemeral: interaction.inGuild() });
}

async function handleSettingsButtonInteraction(
  interaction: ButtonInteraction,
  config: BridgeConfig,
  state: BridgeState,
  updateState: (next: BridgeState) => Promise<void>,
  tenant: TenantReference
): Promise<boolean> {
  const parsed = parseSettingsCustomId(interaction.customId);
  if (!parsed) return false;

  const currentSection = parsed.section;
  const targetChannelId = parsed.targetChannelId;
  const context = interaction;

  const rerender = async (section: SettingsSection = currentSection): Promise<void> => {
    await interaction.update(buildSettingsPanel(state, tenant, config, context, section, targetChannelId));
  };

  if (parsed.action === "switch") {
    await rerender(currentSection);
    return true;
  }

  if (parsed.action === "link-dm") {
    if (!canEditDmSettings(interaction, tenant)) {
      await interaction.reply({ content: "This DM settings panel is only for the linked account.", ephemeral: true });
      return true;
    }

    await interaction.showModal(buildDmSetupModal(interaction.user.id));
    return true;
  }

  if (parsed.action === "reset-dm") {
    if (!canEditDmSettings(interaction, tenant)) {
      await interaction.reply({ content: "This DM settings panel is only for the linked account.", ephemeral: true });
      return true;
    }

    const nextState = tenant.kind === "owner" ? clearOwnerLink(state) : clearUserLink(state, interaction.user.id);
    Object.assign(state, nextState);
    await updateState(state);
    await rerender("account");
    return true;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Guild settings can only be changed in a server.", ephemeral: true });
    return true;
  }

  if (!canManageGuildInstallation(interaction)) {
    await interaction.reply({ content: "Only the server owner or an administrator can change guild settings.", ephemeral: true });
    return true;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "This server is not available right now.", ephemeral: true });
    return true;
  }

  const selectedChannelId = targetChannelId ?? interaction.channelId;
  const installation = state.guildInstallations[guildId];

  if (parsed.action === "link-guild") {
    await interaction.showModal(buildGuildSetupModal(guildId, selectedChannelId, interaction.user.id));
    return true;
  }

  if (!installation) {
    await interaction.reply({ content: "This server is not set up yet. Use the Guild section to link it first.", ephemeral: true });
    return true;
  }

  if (parsed.action === "enable-channel") {
    Object.assign(state, setGuildChannelAccess(state, guildId, selectedChannelId, true));
    await updateState(state);
    await rerender("guild");
    return true;
  }

  if (parsed.action === "disable-channel") {
    Object.assign(state, setGuildChannelAccess(state, guildId, selectedChannelId, false));
    await updateState(state);
    await rerender("guild");
    return true;
  }

  if (parsed.action === "toggle-unrestricted-default") {
    Object.assign(state, setGuildUnrestrictedReplyMode(state, guildId, !installation.guildUnrestrictedRepliesEnabled));
    await updateState(state);
    await rerender("guild");
    return true;
  }

  if (parsed.action === "enable-unrestricted-here") {
    Object.assign(state, setGuildUnrestrictedChannelOverride(state, guildId, selectedChannelId, true));
    await updateState(state);
    await rerender("guild");
    return true;
  }

  if (parsed.action === "disable-unrestricted-here") {
    Object.assign(state, setGuildUnrestrictedChannelOverride(state, guildId, selectedChannelId, false));
    await updateState(state);
    await rerender("guild");
    return true;
  }

  if (parsed.action === "clear-unrestricted-override") {
    Object.assign(state, setGuildUnrestrictedChannelOverride(state, guildId, selectedChannelId, null));
    await updateState(state);
    await rerender("guild");
    return true;
  }

  if (parsed.action === "toggle-proactive-default") {
    Object.assign(state, setGuildProactiveReplyMode(state, guildId, !installation.proactiveRepliesEnabled));
    await updateState(state);
    await rerender("proactive");
    return true;
  }

  if (parsed.action === "enable-proactive-here") {
    Object.assign(state, setGuildProactiveChannelOverride(state, guildId, selectedChannelId, true));
    await updateState(state);
    await rerender("proactive");
    return true;
  }

  if (parsed.action === "disable-proactive-here") {
    Object.assign(state, setGuildProactiveChannelOverride(state, guildId, selectedChannelId, false));
    await updateState(state);
    await rerender("proactive");
    return true;
  }

  if (parsed.action === "clear-proactive-override") {
    Object.assign(state, setGuildProactiveChannelOverride(state, guildId, selectedChannelId, null));
    await updateState(state);
    await rerender("proactive");
    return true;
  }

  if (parsed.action === "reset-guild") {
    Object.assign(state, removeGuildInstallation(state, guildId));
    await updateState(state);
    await interaction.update(buildSettingsPanel(state, tenant, config, context, "overview", selectedChannelId));
    return true;
  }

  return false;
}

async function handleDmMessage(message: Message, config: BridgeConfig, state: BridgeState, updateState: (next: BridgeState) => Promise<void>, onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>, voiceManager: VoiceManager): Promise<void> {
  const tenant = getTenantForDm(config, message.author.id);
  const command = readCommand(message.content);
  const tenantSecret = getTenantSecretState(state, tenant);

  if (command === "setup" || command === "status" || command === "reset") {
    await sendTextMessage(message.channel, "Use /poke settings in this DM to manage your account link.");
    return;
  }

  if (!tenantSecret?.encryptedPokeApiKey) {
    await sendTextMessage(message.channel, "Use /poke settings in this DM to link this account.");
    return;
  }

  if (state.recentMessageIds.includes(message.id)) return;
  Object.assign(state, rememberMessageId(state, message.id));
  await updateState(state);

  const request = await buildDiscordRequestFromMessage(config, state, message, tenant, voiceManager, message.content);
  request.prompt = buildDiscordRelayPrompt(request);
  await onRelayRequest(request);
}

async function handleGuildMessage(message: Message, config: BridgeConfig, state: BridgeState, updateState: (next: BridgeState) => Promise<void>, onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>, botUserId: string, voiceManager: VoiceManager): Promise<void> {
  if (!message.guildId) return;

  if (!isGuildChannelAllowed(state, message.guildId, message.channelId)) return;

  const tenant = getTenantForGuild(message.guildId);
  const tenantSecret = getTenantSecretState(state, tenant);
  const mentioned = message.mentions.users.has(botUserId);
  const repliedToBot = await isReplyToBotMessage(message, botUserId);
  const proactiveAllowed = isGuildProactiveRepliesAllowed(state, message.guildId, message.channelId);
  const activeConversation = getGuildProactiveConversationState(state, message.guildId, message.channelId);
  const contextMessages = await collectChannelContext(message.channel, Math.max(config.contextMessageCount, PROACTIVE_CONTEXT_RECENT_MESSAGE_LIMIT));
  const decision = evaluateGuildProactiveReply({
    content: message.content,
    mentioned,
    repliedToBot,
    proactiveAllowed,
    activeConversation,
    channelContext: contextMessages,
    botUserId,
    messageTimestamp: new Date(message.createdTimestamp).toISOString()
  });

  if (isDisableRequest(message.content) && (mentioned || repliedToBot || isPokeCallout(message.content))) {
    await sendTextMessage(message.channel, "An administrator can turn off proactive replies from /poke settings.");
    return;
  }

  if (!decision.shouldRelay) return;

  if (!tenantSecret?.encryptedPokeApiKey) {
    await sendTextMessage(message.channel, "This server is not set up yet. An administrator should open /poke settings.");
    return;
  }

  if (state.recentMessageIds.includes(message.id)) return;
  Object.assign(state, rememberMessageId(state, message.id));
  await updateState(state);

  const promptContent = mentioned ? stripBotMentions(message.content, botUserId) : decision.promptContent;
  const request = await buildDiscordRequestFromMessage(config, state, message, tenant, voiceManager, promptContent, contextMessages);
  request.prompt = buildDiscordRelayPrompt(request);
  const result = await onRelayRequest(request);

  if (result.success) {
    if (decision.startConversation) {
      Object.assign(state, startGuildProactiveConversation(state, message.guildId, message.channelId, PROACTIVE_THREAD_TURNS, PROACTIVE_THREAD_WINDOW_MS));
      await updateState(state);
      return;
    }

    if (decision.consumeConversation) {
      Object.assign(state, consumeGuildProactiveConversationTurn(state, message.guildId, message.channelId, PROACTIVE_THREAD_WINDOW_MS));
      await updateState(state);
    }
  }
}

async function registerCommands(client: Client): Promise<void> {
  const application = await client.application?.fetch();
  if (!application) return;
  await application.commands.set([createSlashCommand()]);
}

function createSlashCommand() {
  const command = new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Send a message to Poke or open settings.");

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
      .setName("settings")
      .setDescription("Open the Poke settings panel.")
      .addChannelOption(option => option
        .setName("channel")
        .setDescription("Channel to manage. Defaults to the current channel.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)))

  return command.setContexts([InteractionContextType.Guild, InteractionContextType.BotDM]).setIntegrationTypes([ApplicationIntegrationType.GuildInstall]).setDMPermission(true);
}

export async function startDiscordBot(
  config: BridgeConfig,
  state: BridgeState,
  updateState: (next: BridgeState) => Promise<void>,
  onRelayRequest: (request: DiscordRelayRequest) => Promise<PokeSendResult>
): Promise<{ client: Client; voiceManager: VoiceManager; }> {
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel]
  });
  const voiceManager = createVoiceManager(client, config, async (channelId, content) => { await sendDiscordMessage(client, channelId, content); });

  client.on("messageCreate", async message => {
    if (message.author.bot) return;

    try {
      if (message.guildId == null) {
        await handleDmMessage(message, config, state, updateState, onRelayRequest, voiceManager);
        return;
      }

      const botUserId = client.user?.id;
      if (!botUserId) return;
      await handleGuildMessage(message, config, state, updateState, onRelayRequest, botUserId, voiceManager);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await sendTextMessage(message.channel, `Poke bridge failed: ${reason}`);
    }
  });

  client.on("interactionCreate", async interaction => {
    try {
      if (interaction.isModalSubmit()) {
        const dmParsed = parseDmSetupModal(interaction.customId);
        if (dmParsed) {
          if (interaction.inGuild()) {
            await interaction.reply({ content: "Use /poke settings in a DM.", ephemeral: true });
            return;
          }
          if (interaction.user.id !== dmParsed.userId) {
            await interaction.reply({ content: "This setup session no longer matches.", ephemeral: true });
            return;
          }

          const apiKey = interaction.fields.getTextInputValue("apiKey").trim();
          if (!isLikelyPokeApiKey(apiKey)) {
            await interaction.reply({ content: "That does not look like a valid Poke API key.", ephemeral: true });
            return;
          }

          const encrypted = encryptTenantSecret(apiKey, config.stateSecret);
          const tenant = getTenantForDm(config, interaction.user.id);
          const dmChannelId = interaction.channelId ?? interaction.channel?.id ?? null;
          if (!dmChannelId) {
            await interaction.reply({ content: "Could not determine the DM channel for setup.", ephemeral: true });
            return;
          }

          const nextState = setTenantSecretState(state, tenant, encrypted, interaction.user.id, dmChannelId);
          Object.assign(state, nextState);
          await updateState(state);
          await interaction.reply({ content: `Linked ${tenant.kind === "owner" ? "owner" : "your account"} to Poke.`, ephemeral: false });
          return;
        }

        const parsed = parseGuildSetupModal(interaction.customId);
        if (!parsed) return;
        if (!interaction.inGuild()) {
          await interaction.reply({ content: "Use /poke settings in a server.", ephemeral: true });
          return;
        }
        if (!canManageGuildInstallation(interaction)) {
          await interaction.reply({ content: "Only the server owner or an administrator can set this up.", ephemeral: true });
          return;
        }
        if (interaction.guildId !== parsed.guildId || interaction.user.id !== parsed.userId) {
          await interaction.reply({ content: "This setup session no longer matches.", ephemeral: true });
          return;
        }

        const apiKey = interaction.fields.getTextInputValue("apiKey").trim();
        if (!isLikelyPokeApiKey(apiKey)) {
          await interaction.reply({ content: "That does not look like a valid Poke API key.", ephemeral: true });
          return;
        }

        const encrypted = encryptTenantSecret(apiKey, config.stateSecret);
        const nextState = installGuildChannel(state, parsed.guildId, interaction.user.id, parsed.channelId, encrypted);
        Object.assign(state, nextState);
        await updateState(state);
        await interaction.reply({ content: `Poke is now enabled in <#${parsed.channelId}>.`, ephemeral: true });
        return;
      }

      if (interaction.isButton()) {
        const tenant = interaction.inGuild() ? getTenantForGuild(interaction.guildId) : getTenantForDm(config, interaction.user.id);
        if (await handleSettingsButtonInteraction(interaction, config, state, updateState, tenant)) {
          return;
        }
      }

      if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) return;

      const subcommand = interaction.options.getSubcommand();
      const tenant = interaction.inGuild() ? getTenantForGuild(interaction.guildId) : getTenantForDm(config, interaction.user.id);
      if (subcommand === "settings") {
        const targetChannelId = interaction.inGuild() ? getSettingsTargetChannelId(interaction, interaction.channelId) : null;
        if (interaction.inGuild() && !canManageGuildInstallation(interaction)) {
          await respond(interaction, "Only the server owner or an administrator can open guild settings.");
          return;
        }

        await interaction.reply({
          ...buildSettingsPanel(state, tenant, config, interaction, interaction.inGuild() ? "overview" : "account", targetChannelId),
          ephemeral: interaction.inGuild()
        });
        return;
      }

      if (subcommand !== "send") return;
      const tenantSecret = getTenantSecretState(state, tenant);

      if (interaction.inGuild() && !isGuildChannelAllowed(state, interaction.guildId, interaction.channelId)) {
        await respond(interaction, "This channel is not enabled for Poke yet.");
        return;
      }

      if (!tenantSecret?.encryptedPokeApiKey) {
        await respond(interaction, tenant.kind === "guild"
          ? "This server is not set up yet. An administrator should open /poke settings."
          : "Paste your Poke API key in this DM to link this account.");
        return;
      }

      await interaction.deferReply({ ephemeral: interaction.inGuild() });

      const request = await buildDiscordRequestFromInteraction(config, state, interaction as ChatInputCommandInteraction, tenant, voiceManager);
      request.prompt = buildDiscordRelayPrompt(request);
      await onRelayRequest(request);
      await interaction.editReply("Sent to Poke.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(`Poke bridge failed: ${reason}`);
        } else {
          await interaction.reply({ content: `Poke bridge failed: ${reason}`, ephemeral: interaction.inGuild() });
        }
      }
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
  return { client, voiceManager };
}

function isReactableMessage(message: unknown): message is { react: (emoji: string) => Promise<unknown>; } {
  return typeof message === "object" && message != null && "react" in message && typeof (message as { react?: unknown }).react === "function";
}

export async function sendDiscordMessage(client: Client, channelId: string, content: string, options: OutboundMessageOptions = {}): Promise<string[]> {
  const channel = await resolveSendTargetChannel(client, channelId, options.userId);
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

export async function startDeferredTypingIndicator(
  client: Client,
  channelId: string,
  delayMs = 200,
  startIndicator: (client: Client, channelId: string) => Promise<() => Promise<void>> = startTypingIndicator
): Promise<() => Promise<void>> {
  let stopped = false;
  let stopTyping: (() => Promise<void>) | null = null;
  let startPromise: Promise<void> | null = null;

  const timer = setTimeout(() => {
    if (stopped) return;

    startPromise = (async () => {
      try {
        stopTyping = await startIndicator(client, channelId);
        if (stopped) {
          await stopTyping();
        }
      } catch {
        stopTyping = null;
      }
    })();
  }, delayMs);

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await startPromise;
    await stopTyping?.();
  };
}
