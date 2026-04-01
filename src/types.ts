export type BridgeMode = "private" | "public";

export interface PrivateBridgeState {
  ownerUserId: string | null;
  dmChannelId: string | null;
  linkedAt: number | null;
}

export interface GuildInstallationState {
  installedByUserId: string;
  installedAt: number;
  updatedAt: number;
  allowedChannelIds: string[];
}

export interface BridgeConfig {
  discordToken: string;
  pokeApiKey: string;
  pokeApiBaseUrl: string;
  mcpHost: string;
  mcpPort: number;
  statePath: string;
  autoTunnel: boolean;
  contextMessageCount: number;
  edgeSecret: string | null;
  bridgeMode: BridgeMode;
}

export interface BridgeState {
  mode: BridgeMode;
  private: PrivateBridgeState;
  guildInstallations: Record<string, GuildInstallationState>;
  recentMessageIds: string[];
}

export interface DiscordAttachmentContext {
  name: string;
  url: string;
  contentType: string | null;
  size: number;
}

export interface DiscordOutboundAttachment {
  name?: string;
  url: string;
  contentType?: string | null;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordOutboundEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; iconUrl?: string; };
  author?: { name: string; url?: string; iconUrl?: string; };
  thumbnailUrl?: string;
  imageUrl?: string;
  fields?: DiscordEmbedField[];
}

export interface DiscordMessageContext {
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: DiscordAttachmentContext[];
}

export interface DiscordReplyTarget {
  channelId: string;
  label: string | null;
  mode: "dm" | "guild";
  createdAt: number;
}

export interface DiscordSentMessageRecord {
  channelId: string;
  messageIds: string[];
  updatedAt: number;
}

export interface DiscordRelayRequest {
  bridgeRequestId: string;
  discordUserId: string;
  discordChannelId: string;
  discordMessageId: string;
  mode: "dm" | "guild";
  prompt: string;
  replyTarget: DiscordReplyTarget;
  attachments: DiscordAttachmentContext[];
  contextMessages: DiscordMessageContext[];
}

export interface PokeSendResult {
  success: boolean;
  message?: string;
}
