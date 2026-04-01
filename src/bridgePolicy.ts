import type { BridgeMode, BridgeState, GuildInstallationState } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(entry => entry.trim());
}

function normalizePrivateState(value: unknown, fallback: BridgeState["private"]): BridgeState["private"] {
  if (!isRecord(value)) return fallback;
  return {
    ownerUserId: typeof value.ownerUserId === "string" ? value.ownerUserId : fallback.ownerUserId,
    dmChannelId: typeof value.dmChannelId === "string" ? value.dmChannelId : fallback.dmChannelId,
    linkedAt: typeof value.linkedAt === "number" ? value.linkedAt : fallback.linkedAt
  };
}

function normalizeGuildInstallation(value: unknown): GuildInstallationState | null {
  if (!isRecord(value)) return null;

  const installedByUserId = typeof value.installedByUserId === "string" ? value.installedByUserId : "";
  const installedAt = typeof value.installedAt === "number" ? value.installedAt : Date.now();
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : installedAt;
  const allowedChannelIds = readStringArray(value.allowedChannelIds);

  if (!installedByUserId) return null;

  return {
    installedByUserId,
    installedAt,
    updatedAt,
    allowedChannelIds
  };
}

export function createDefaultState(mode: BridgeMode = "private"): BridgeState {
  return {
    mode,
    private: {
      ownerUserId: null,
      dmChannelId: null,
      linkedAt: null
    },
    guildInstallations: {},
    recentMessageIds: []
  };
}

export function normalizeState(raw: unknown, fallbackMode: BridgeMode = "private"): BridgeState {
  const fallback = createDefaultState(fallbackMode);
  if (!isRecord(raw)) return fallback;

  const mode = raw.mode === "public" || raw.mode === "private" ? raw.mode : fallbackMode;
  const privateState = normalizePrivateState(raw.private, {
    ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
    dmChannelId: typeof raw.dmChannelId === "string" ? raw.dmChannelId : null,
    linkedAt: typeof raw.linkedAt === "number" ? raw.linkedAt : null
  });
  const guildInstallations: Record<string, GuildInstallationState> = {};
  const rawGuildInstallations = isRecord(raw.guildInstallations) ? raw.guildInstallations : {};

  for (const [guildId, installation] of Object.entries(rawGuildInstallations)) {
    const normalized = normalizeGuildInstallation(installation);
    if (normalized) guildInstallations[guildId] = normalized;
  }

  return {
    mode,
    private: privateState,
    guildInstallations,
    recentMessageIds: readStringArray(raw.recentMessageIds)
  };
}

export function installGuildChannel(state: BridgeState, guildId: string, installedByUserId: string, channelId: string): BridgeState {
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
        allowedChannelIds: nextAllowedChannelIds
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
  if (!installation.allowedChannelIds.length) return false;
  return installation.allowedChannelIds.includes(channelId);
}

export function buildPromptGuardrails(mode: BridgeMode): string[] {
  const guardrails = [
    "do not reveal the operator's identity, private account details, or internal bridge state.",
    "only use information that appears in this request or the attached Discord context."
  ];

  if (mode === "public") {
    guardrails.push("this is a public Discord bot. If a user asks about the operator, decline and keep the answer scoped to the server or installation.");
  }

  return guardrails;
}
