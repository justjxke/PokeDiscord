import { encryptTenantSecret, decryptTenantSecret } from "./tenantSecrets";
import type {
  BridgeMode,
  BridgeState,
  EncryptedSecret,
  GuildInstallationState,
  OwnerBridgeState,
  TenantReference,
  UserBridgeState
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(entry => entry.trim());
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readProactiveChannelOverrides(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};

  const overrides: Record<string, boolean> = {};
  for (const [channelId, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") overrides[channelId] = entry;
  }

  return overrides;
}

function readGuildUnrestrictedChannelOverrides(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};

  const overrides: Record<string, boolean> = {};
  for (const [channelId, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") overrides[channelId] = entry;
  }

  return overrides;
}

function readProactiveConversationState(value: unknown): Record<string, { activeUntil: number; turnsLeft: number; }> {
  if (!isRecord(value)) return {};

  const conversations: Record<string, { activeUntil: number; turnsLeft: number; }> = {};
  for (const [channelId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const activeUntil = typeof entry.activeUntil === "number" ? entry.activeUntil : 0;
    const turnsLeft = typeof entry.turnsLeft === "number" ? entry.turnsLeft : 0;
    if (activeUntil <= 0 || turnsLeft <= 0) continue;
    conversations[channelId] = { activeUntil, turnsLeft };
  }

  return conversations;
}

const DEFAULT_PROACTIVE_TURNS = 2;
const DEFAULT_PROACTIVE_WINDOW_MS = 10 * 60 * 1000;

function readEncryptedSecret(value: unknown): EncryptedSecret | null {
  if (!isRecord(value)) return null;
  if (value.algorithm !== "aes-256-gcm") return null;
  if (typeof value.salt !== "string" || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") {
    return null;
  }
  if (typeof value.createdAt !== "number") return null;

  return {
    algorithm: "aes-256-gcm",
    salt: value.salt,
    iv: value.iv,
    tag: value.tag,
    ciphertext: value.ciphertext,
    createdAt: value.createdAt
  };
}

function migrateLegacySecret(value: unknown, stateSecret: string, createdAt: number): EncryptedSecret | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return encryptTenantSecret(trimmed, stateSecret, createdAt);
}

function readOwnerDiscordUserId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readDmChannelId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function normalizeOwnerState(value: unknown, fallback: OwnerBridgeState, stateSecret: string): OwnerBridgeState {
  if (!isRecord(value)) return fallback;
  const linkedAt = typeof value.linkedAt === "number" ? value.linkedAt : fallback.linkedAt;
  const encryptedPokeApiKey = readEncryptedSecret(value.encryptedPokeApiKey)
    ?? migrateLegacySecret(value.pokeApiKey, stateSecret, linkedAt ?? Date.now());

  return {
    discordUserId: readOwnerDiscordUserId(value.discordUserId ?? value.ownerUserId) ?? fallback.discordUserId,
    dmChannelId: readDmChannelId(value.dmChannelId) ?? fallback.dmChannelId,
    linkedAt,
    encryptedPokeApiKey
  };
}

function normalizeUserState(value: unknown, stateSecret: string): UserBridgeState | null {
  if (!isRecord(value)) return null;
  const dmChannelId = readDmChannelId(value.dmChannelId);
  const linkedAt = typeof value.linkedAt === "number" ? value.linkedAt : Date.now();
  const encryptedPokeApiKey = readEncryptedSecret(value.encryptedPokeApiKey)
    ?? migrateLegacySecret(value.pokeApiKey, stateSecret, linkedAt);

  if (!dmChannelId) return null;
  return {
    dmChannelId,
    linkedAt,
    encryptedPokeApiKey
  };
}

function normalizeGuildInstallation(value: unknown, stateSecret: string): GuildInstallationState | null {
  if (!isRecord(value)) return null;

  const installedByUserId = typeof value.installedByUserId === "string" ? value.installedByUserId : "";
  const installedAt = typeof value.installedAt === "number" ? value.installedAt : Date.now();
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : installedAt;
  const linkedAt = typeof value.linkedAt === "number" ? value.linkedAt : null;
  const allowedChannelIds = readStringArray(value.allowedChannelIds);
  const encryptedPokeApiKey = readEncryptedSecret(value.encryptedPokeApiKey)
    ?? migrateLegacySecret(value.pokeApiKey, stateSecret, linkedAt ?? installedAt);
  const guildUnrestrictedRepliesEnabled = readBoolean(value.guildUnrestrictedRepliesEnabled, false);
  const guildUnrestrictedChannelOverrides = readGuildUnrestrictedChannelOverrides(value.guildUnrestrictedChannelOverrides);
  const proactiveRepliesEnabled = readBoolean(value.proactiveRepliesEnabled, true);
  const proactiveChannelOverrides = readProactiveChannelOverrides(value.proactiveChannelOverrides ?? value.proactiveChannelIds);
  const proactiveConversationState = readProactiveConversationState(value.proactiveConversationState);

  if (!installedByUserId) return null;

  return {
    installedByUserId,
    installedAt,
    updatedAt,
    linkedAt,
    allowedChannelIds,
    encryptedPokeApiKey,
    guildUnrestrictedRepliesEnabled,
    guildUnrestrictedChannelOverrides,
    proactiveRepliesEnabled,
    proactiveChannelOverrides,
    proactiveConversationState
  };
}

function normalizeUsers(value: unknown, stateSecret: string): Record<string, UserBridgeState> {
  if (!isRecord(value)) return {};

  const users: Record<string, UserBridgeState> = {};
  for (const [userId, entry] of Object.entries(value)) {
    const normalized = normalizeUserState(entry, stateSecret);
    if (normalized) users[userId] = normalized;
  }

  return users;
}

function normalizeGuildInstallations(value: unknown, stateSecret: string): Record<string, GuildInstallationState> {
  if (!isRecord(value)) return {};

  const guildInstallations: Record<string, GuildInstallationState> = {};
  for (const [guildId, entry] of Object.entries(value)) {
    const normalized = normalizeGuildInstallation(entry, stateSecret);
    if (normalized) guildInstallations[guildId] = normalized;
  }

  return guildInstallations;
}

function assertOptionalString(value: unknown, label: string): void {
  if (value != null && typeof value !== "string") {
    throw new Error(`${label} must be a string when present.`);
  }
}

function assertOptionalNumber(value: unknown, label: string): void {
  if (value != null && typeof value !== "number") {
    throw new Error(`${label} must be a number when present.`);
  }
}

function assertEncryptedSecretShape(value: unknown, label: string): void {
  if (value == null) {
    return;
  }

  if (!readEncryptedSecret(value)) {
    throw new Error(`${label} is not a valid encrypted secret.`);
  }
}

export function assertPersistedStateShape(raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error("Persisted state must be a JSON object.");
  }

  if (raw.owner != null) {
    if (!isRecord(raw.owner)) {
      throw new Error("owner must be an object when present.");
    }

    assertOptionalString(raw.owner.discordUserId ?? raw.owner.ownerUserId, "owner.discordUserId");
    assertOptionalString(raw.owner.dmChannelId, "owner.dmChannelId");
    assertOptionalNumber(raw.owner.linkedAt, "owner.linkedAt");
    assertOptionalString(raw.owner.pokeApiKey, "owner.pokeApiKey");
    assertEncryptedSecretShape(raw.owner.encryptedPokeApiKey, "owner.encryptedPokeApiKey");
  }

  if (raw.users != null) {
    if (!isRecord(raw.users)) {
      throw new Error("users must be an object when present.");
    }

    for (const [userId, value] of Object.entries(raw.users)) {
      if (!isRecord(value)) {
        throw new Error(`users.${userId} must be an object.`);
      }

      if (typeof value.dmChannelId !== "string" || !value.dmChannelId.trim().length) {
        throw new Error(`users.${userId}.dmChannelId must be a non-empty string.`);
      }

      assertOptionalNumber(value.linkedAt, `users.${userId}.linkedAt`);
      assertOptionalString(value.pokeApiKey, `users.${userId}.pokeApiKey`);
      assertEncryptedSecretShape(value.encryptedPokeApiKey, `users.${userId}.encryptedPokeApiKey`);
    }
  }

  if (raw.guildInstallations != null) {
    if (!isRecord(raw.guildInstallations)) {
      throw new Error("guildInstallations must be an object when present.");
    }

    for (const [guildId, value] of Object.entries(raw.guildInstallations)) {
      if (!isRecord(value)) {
        throw new Error(`guildInstallations.${guildId} must be an object.`);
      }

      if (typeof value.installedByUserId !== "string" || !value.installedByUserId.trim().length) {
        throw new Error(`guildInstallations.${guildId}.installedByUserId must be a non-empty string.`);
      }

      assertOptionalNumber(value.installedAt, `guildInstallations.${guildId}.installedAt`);
      assertOptionalNumber(value.updatedAt, `guildInstallations.${guildId}.updatedAt`);
      assertOptionalNumber(value.linkedAt, `guildInstallations.${guildId}.linkedAt`);
      if (value.allowedChannelIds != null && !Array.isArray(value.allowedChannelIds)) {
        throw new Error(`guildInstallations.${guildId}.allowedChannelIds must be an array when present.`);
      }
      if (Array.isArray(value.allowedChannelIds) && value.allowedChannelIds.some(entry => typeof entry !== "string")) {
        throw new Error(`guildInstallations.${guildId}.allowedChannelIds must contain only strings.`);
      }
      assertOptionalString(value.pokeApiKey, `guildInstallations.${guildId}.pokeApiKey`);
      assertEncryptedSecretShape(value.encryptedPokeApiKey, `guildInstallations.${guildId}.encryptedPokeApiKey`);
      if (value.guildUnrestrictedRepliesEnabled != null && typeof value.guildUnrestrictedRepliesEnabled !== "boolean") {
        throw new Error(`guildInstallations.${guildId}.guildUnrestrictedRepliesEnabled must be a boolean when present.`);
      }
      if (value.guildUnrestrictedChannelOverrides != null && !isRecord(value.guildUnrestrictedChannelOverrides)) {
        throw new Error(`guildInstallations.${guildId}.guildUnrestrictedChannelOverrides must be an object when present.`);
      }
      if (isRecord(value.guildUnrestrictedChannelOverrides) && Object.values(value.guildUnrestrictedChannelOverrides).some(entry => typeof entry !== "boolean")) {
        throw new Error(`guildInstallations.${guildId}.guildUnrestrictedChannelOverrides must contain only booleans.`);
      }
      if (value.proactiveRepliesEnabled != null && typeof value.proactiveRepliesEnabled !== "boolean") {
        throw new Error(`guildInstallations.${guildId}.proactiveRepliesEnabled must be a boolean when present.`);
      }
      if (value.proactiveChannelOverrides != null && !isRecord(value.proactiveChannelOverrides)) {
        throw new Error(`guildInstallations.${guildId}.proactiveChannelOverrides must be an object when present.`);
      }
      if (isRecord(value.proactiveChannelOverrides) && Object.values(value.proactiveChannelOverrides).some(entry => typeof entry !== "boolean")) {
        throw new Error(`guildInstallations.${guildId}.proactiveChannelOverrides must contain only booleans.`);
      }
      if (value.proactiveConversationState != null && !isRecord(value.proactiveConversationState)) {
        throw new Error(`guildInstallations.${guildId}.proactiveConversationState must be an object when present.`);
      }
    }
  }

  if (raw.recentMessageIds != null && (!Array.isArray(raw.recentMessageIds) || raw.recentMessageIds.some(value => typeof value !== "string"))) {
    throw new Error("recentMessageIds must be an array of strings when present.");
  }
}

export function createDefaultState(_mode: BridgeMode = "hybrid"): BridgeState {
  return {
    mode: "hybrid",
    owner: {
      discordUserId: null,
      dmChannelId: null,
      linkedAt: null,
      encryptedPokeApiKey: null
    },
    users: {},
    guildInstallations: {},
    recentMessageIds: []
  };
}

export function normalizeState(raw: unknown, stateSecret: string, _fallbackMode: BridgeMode = "hybrid"): BridgeState {
  const fallback = createDefaultState();
  if (!isRecord(raw)) return fallback;

  const ownerSource = isRecord(raw.owner)
    ? raw.owner
    : isRecord(raw.private)
      ? raw.private
      : {
          ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
          dmChannelId: typeof raw.dmChannelId === "string" ? raw.dmChannelId : null,
          linkedAt: typeof raw.linkedAt === "number" ? raw.linkedAt : null,
          pokeApiKey: typeof raw.pokeApiKey === "string" ? raw.pokeApiKey : null,
          encryptedPokeApiKey: isRecord(raw.encryptedPokeApiKey) ? raw.encryptedPokeApiKey : null
        };

  const owner = normalizeOwnerState(ownerSource, fallback.owner, stateSecret);

  return {
    mode: "hybrid",
    owner,
    users: normalizeUsers(raw.users, stateSecret),
    guildInstallations: normalizeGuildInstallations(raw.guildInstallations, stateSecret),
    recentMessageIds: readStringArray(raw.recentMessageIds)
  };
}

export function setOwnerLink(state: BridgeState, discordUserId: string, dmChannelId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  return {
    ...state,
    owner: {
      discordUserId,
      dmChannelId,
      linkedAt: Date.now(),
      encryptedPokeApiKey
    }
  };
}

export function clearOwnerLink(state: BridgeState): BridgeState {
  return {
    ...state,
    owner: {
      discordUserId: null,
      dmChannelId: null,
      linkedAt: null,
      encryptedPokeApiKey: null
    },
    recentMessageIds: []
  };
}

export function setUserLink(state: BridgeState, userId: string, dmChannelId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  return {
    ...state,
    users: {
      ...state.users,
      [userId]: {
        dmChannelId,
        linkedAt: Date.now(),
        encryptedPokeApiKey
      }
    }
  };
}

export function clearUserLink(state: BridgeState, userId: string): BridgeState {
  if (!state.users[userId]) return state;

  const users = { ...state.users };
  delete users[userId];
  return {
    ...state,
    users
  };
}

export function installGuildChannel(state: BridgeState, guildId: string, installedByUserId: string, channelId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  const existing = state.guildInstallations[guildId];
  const allowedChannelIds = existing?.allowedChannelIds ?? [];
  const nextAllowedChannelIds = Array.from(new Set([channelId, ...allowedChannelIds]));

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        installedByUserId,
        installedAt: existing?.installedAt ?? Date.now(),
        updatedAt: Date.now(),
        linkedAt: existing?.linkedAt ?? Date.now(),
        allowedChannelIds: nextAllowedChannelIds,
        encryptedPokeApiKey,
        guildUnrestrictedRepliesEnabled: existing?.guildUnrestrictedRepliesEnabled ?? false,
        guildUnrestrictedChannelOverrides: existing?.guildUnrestrictedChannelOverrides ?? {},
        proactiveRepliesEnabled: existing?.proactiveRepliesEnabled ?? true,
        proactiveChannelOverrides: existing?.proactiveChannelOverrides ?? {},
        proactiveConversationState: existing?.proactiveConversationState ?? {}
      }
    }
  };
}

export function setGuildKey(state: BridgeState, guildId: string, installedByUserId: string, encryptedPokeApiKey: EncryptedSecret): BridgeState {
  const existing = state.guildInstallations[guildId];
  if (!existing) {
    return {
      ...state,
      guildInstallations: {
        ...state.guildInstallations,
        [guildId]: {
          installedByUserId,
          installedAt: Date.now(),
          updatedAt: Date.now(),
          linkedAt: Date.now(),
          allowedChannelIds: [],
          encryptedPokeApiKey,
          guildUnrestrictedRepliesEnabled: false,
          guildUnrestrictedChannelOverrides: {},
          proactiveRepliesEnabled: true,
          proactiveChannelOverrides: {},
          proactiveConversationState: {}
        }
      }
    };
  }

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...existing,
        installedByUserId,
        updatedAt: Date.now(),
        linkedAt: existing.linkedAt ?? Date.now(),
        encryptedPokeApiKey,
        guildUnrestrictedRepliesEnabled: existing.guildUnrestrictedRepliesEnabled ?? false,
        guildUnrestrictedChannelOverrides: existing.guildUnrestrictedChannelOverrides ?? {},
        proactiveRepliesEnabled: existing.proactiveRepliesEnabled ?? true,
        proactiveChannelOverrides: existing.proactiveChannelOverrides ?? {},
        proactiveConversationState: existing.proactiveConversationState ?? {}
      }
    }
  };
}

export function removeGuildInstallation(state: BridgeState, guildId: string): BridgeState {
  if (!state.guildInstallations[guildId]) return state;

  const nextGuildInstallations = { ...state.guildInstallations };
  delete nextGuildInstallations[guildId];

  return {
    ...state,
    guildInstallations: nextGuildInstallations
  };
}

export function isGuildChannelAllowed(state: BridgeState, guildId: string, channelId: string): boolean {
  const installation = state.guildInstallations[guildId];
  if (!installation) return false;
  if (isGuildUnrestrictedRepliesAllowed(state, guildId, channelId)) return true;
  if (!installation.allowedChannelIds.length) return false;
  return installation.allowedChannelIds.includes(channelId);
}

export type UnrestrictedReplyChannelMode = "inherit" | "enabled" | "disabled";

export function getGuildUnrestrictedReplyMode(state: BridgeState, guildId: string, channelId: string): UnrestrictedReplyChannelMode {
  const installation = state.guildInstallations[guildId];
  if (!installation) return "disabled";
  const override = installation.guildUnrestrictedChannelOverrides[channelId];
  if (typeof override === "boolean") return override ? "enabled" : "disabled";
  return installation.guildUnrestrictedRepliesEnabled ? "enabled" : "disabled";
}

export function isGuildUnrestrictedRepliesAllowed(state: BridgeState, guildId: string, channelId: string): boolean {
  return getGuildUnrestrictedReplyMode(state, guildId, channelId) === "enabled";
}

export function setGuildUnrestrictedReplyMode(state: BridgeState, guildId: string, enabled: boolean): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        guildUnrestrictedRepliesEnabled: enabled
      }
    }
  };
}

export function setGuildUnrestrictedChannelOverride(state: BridgeState, guildId: string, channelId: string, enabled: boolean | null): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;
  const guildUnrestrictedChannelOverrides = { ...(installation.guildUnrestrictedChannelOverrides ?? {}) };
  if (enabled == null) {
    delete guildUnrestrictedChannelOverrides[channelId];
  } else {
    guildUnrestrictedChannelOverrides[channelId] = enabled;
  }

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        guildUnrestrictedChannelOverrides
      }
    }
  };
}

export function setGuildChannelAccess(state: BridgeState, guildId: string, channelId: string, enabled: boolean): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;
  const allowedChannelIds = new Set(installation.allowedChannelIds);
  if (enabled) {
    allowedChannelIds.add(channelId);
  } else {
    allowedChannelIds.delete(channelId);
  }

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        allowedChannelIds: Array.from(allowedChannelIds)
      }
    }
  };
}

export type ProactiveReplyChannelMode = "inherit" | "enabled" | "disabled";

export function getGuildProactiveReplyMode(state: BridgeState, guildId: string, channelId: string): ProactiveReplyChannelMode {
  const installation = state.guildInstallations[guildId];
  if (!installation) return "disabled";
  const override = installation.proactiveChannelOverrides[channelId];
  if (typeof override === "boolean") return override ? "enabled" : "disabled";
  return installation.proactiveRepliesEnabled ? "enabled" : "disabled";
}

export function isGuildProactiveRepliesAllowed(state: BridgeState, guildId: string, channelId: string): boolean {
  return getGuildProactiveReplyMode(state, guildId, channelId) === "enabled";
}

export function getGuildProactiveConversationState(state: BridgeState, guildId: string, channelId: string): { activeUntil: number; turnsLeft: number; } | null {
  const installation = state.guildInstallations[guildId];
  if (!installation) return null;
  const conversation = installation.proactiveConversationState[channelId];
  if (!conversation) return null;
  if (conversation.activeUntil <= Date.now() || conversation.turnsLeft <= 0) return null;
  return conversation;
}

export function setGuildProactiveReplyMode(state: BridgeState, guildId: string, enabled: boolean): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        proactiveRepliesEnabled: enabled
      }
    }
  };
}

export function setGuildProactiveChannelOverride(state: BridgeState, guildId: string, channelId: string, enabled: boolean | null): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;
  const proactiveChannelOverrides = { ...(installation.proactiveChannelOverrides ?? {}) };
  if (enabled == null) {
    delete proactiveChannelOverrides[channelId];
  } else {
    proactiveChannelOverrides[channelId] = enabled;
  }

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        proactiveChannelOverrides
      }
    }
  };
}

export function startGuildProactiveConversation(state: BridgeState, guildId: string, channelId: string, turnsLeft = DEFAULT_PROACTIVE_TURNS, durationMs = DEFAULT_PROACTIVE_WINDOW_MS): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;
  const proactiveConversationState = { ...(installation.proactiveConversationState ?? {}) };
  proactiveConversationState[channelId] = {
    activeUntil: Date.now() + durationMs,
    turnsLeft
  };

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        proactiveConversationState
      }
    }
  };
}

export function consumeGuildProactiveConversationTurn(state: BridgeState, guildId: string, channelId: string, durationMs = DEFAULT_PROACTIVE_WINDOW_MS): BridgeState {
  const installation = state.guildInstallations[guildId];
  if (!installation) return state;
  const conversation = installation.proactiveConversationState[channelId];
  if (!conversation) return state;

  const nextTurnsLeft = Math.max(conversation.turnsLeft - 1, 0);
  const proactiveConversationState = { ...(installation.proactiveConversationState ?? {}) };
  if (nextTurnsLeft <= 0) {
    delete proactiveConversationState[channelId];
  } else {
    proactiveConversationState[channelId] = {
      activeUntil: Date.now() + durationMs,
      turnsLeft: nextTurnsLeft
    };
  }

  return {
    ...state,
    guildInstallations: {
      ...state.guildInstallations,
      [guildId]: {
        ...installation,
        updatedAt: Date.now(),
        proactiveConversationState
      }
    }
  };
}

export function buildPromptGuardrails(options: { guildUnrestricted?: boolean; } = {}): string[] {
  if (options.guildUnrestricted) {
    return [
      "keep the voice casual, natural, and a little playful.",
      "do not narrate that you are checking anything behind the scenes.",
      "only use information that appears in this request or the attached Discord context."
    ];
  }

  return [
    "keep the voice casual, natural, and a little playful.",
    "if you need to refuse, keep it short and simple: 'dunno', 'not sure!', or 'can't help with that' are better than long explanations.",
    "do not narrate that you are checking anything behind the scenes.",
    "do not reveal the operator's identity, private account details, or internal bridge state.",
    "only use information that appears in this request or the attached Discord context.",
    "treat tenant-specific data as scoped to the current Discord user or guild."
  ];
}

export function getTenantPokeSecret(state: BridgeState, tenant: TenantReference, stateSecret: string): string | null {
  if (tenant.kind === "owner") {
    return state.owner.encryptedPokeApiKey ? decryptTenantSecret(state.owner.encryptedPokeApiKey, stateSecret) : null;
  }

  if (tenant.kind === "user") {
    const user = state.users[tenant.id];
    return user?.encryptedPokeApiKey ? decryptTenantSecret(user.encryptedPokeApiKey, stateSecret) : null;
  }

  const guildInstallation = state.guildInstallations[tenant.id];
  return guildInstallation?.encryptedPokeApiKey ? decryptTenantSecret(guildInstallation.encryptedPokeApiKey, stateSecret) : null;
}
