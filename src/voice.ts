import { randomUUID } from "node:crypto";

import type { Client, Guild } from "discord.js";

import { LavalinkManager, type LavalinkPlayer, type LavalinkSearchResponse, type LavalinkTrack } from "./lavalinkClient";
import { searchSpotifyTracks } from "./spotifySearch";
import type {
  BridgeConfig,
  DiscordVoiceChannelSnapshot,
  DiscordVoiceContext,
  DiscordVoiceSessionSnapshot,
  DiscordVoiceTrackSummary,
  DiscordVoiceUserSnapshot
} from "./types";
import { buildSpotifyTrackSearchIdentifier, resolveLavalinkTrackIdentifier } from "./lavalinkResolver";
import { normalizeMusicKey, rankArtistBoundTracks, type MusicSelectionCandidate } from "./musicSelection";

const IDLE_LEAVE_DELAY_MS = 5 * 60 * 1000;
const LAVALINK_DEFAULT_VOICE_TIMEOUT_SECONDS = 15;
const LAVALINK_DEFAULT_REST_TIMEOUT_SECONDS = 60;

let spotifyTokenSetup: Promise<void> | null = null;
let lavalinkManager: LavalinkManager | null = null;

interface VoiceTrack extends DiscordVoiceTrackSummary {
  encoded: string;
  sourceUrl: string;
  lengthMs: number;
  isSeekable: boolean;
  fallbackTracks: LavalinkTrack[];
}

export type LoopMode = "off" | "track" | "queue";

interface VoiceSession {
  guildId: string;
  voiceChannelId: string;
  voiceChannelName: string | null;
  textChannelId: string | null;
  queue: VoiceTrack[];
  currentTrack: VoiceTrack | null;
  hasStartedPlayback: boolean;
  loopMode: LoopMode;
  idleLeaveAt: number | null;
  idleLeaveTimer: NodeJS.Timeout | null;
  player: LavalinkPlayer;
  destroyed: boolean;
}

export interface QueueVoiceTrackInput {
  bridgeRequestId: string;
  guildId: string;
  requesterId: string;
  requesterUsername: string;
  requesterDisplayName: string;
  requesterVoiceChannelId: string;
  requesterVoiceChannelName: string | null;
  textChannelId: string;
  url?: string;
  artist?: string;
  query?: string;
  position?: "front" | "back";
}

export interface ControlVoicePlaybackInput {
  bridgeRequestId: string;
  guildId: string;
  requesterId: string;
  requesterUsername: string;
  requesterDisplayName: string;
  requesterVoiceChannelId: string | null;
  requesterVoiceChannelName: string | null;
  textChannelId: string;
  action: "join" | "pause" | "resume" | "skip" | "stop" | "leave" | "current" | "queue" | "remove" | "clear" | "volume" | "seek" | "shuffle" | "loop" | "move";
  index?: number;
  value?: number;
  positionMs?: number;
  loopMode?: LoopMode;
  fromIndex?: number;
  toIndex?: number;
}

export interface VoiceOperationResult {
  ok: boolean;
  action: string;
  message: string;
  session: DiscordVoiceSessionSnapshot | null;
  track?: DiscordVoiceTrackSummary | null;
  removedTrack?: DiscordVoiceTrackSummary | null;
}

export interface VoiceManager {
  describeVoiceContext(guildId: string, requester: { userId: string; username: string; displayName: string; }): DiscordVoiceContext | null;
  queueVoiceTrack(input: QueueVoiceTrackInput): Promise<VoiceOperationResult>;
  controlVoicePlayback(input: ControlVoicePlaybackInput): Promise<VoiceOperationResult>;
  getSessionSnapshot(guildId: string): DiscordVoiceSessionSnapshot | null;
}

type PlayDlSpotifySearchResultLike = {
  id?: string;
  name: string;
  url: string;
  artists?: { name: string }[];
};

function canonicalVoiceChannel(channelId: string | null, channelName: string | null): DiscordVoiceChannelSnapshot {
  return {
    id: channelId,
    name: channelName
  };
}

function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function summarizeTrack(track: VoiceTrack): DiscordVoiceTrackSummary {
  return {
    id: track.id,
    title: track.title,
    url: track.url,
    requestedByUserId: track.requestedByUserId,
    requestedByName: track.requestedByName,
    requestedAt: track.requestedAt
  };
}

function extractLoadResultTracks(result: LavalinkSearchResponse): LavalinkTrack[] {
  if (result.loadType === "track") {
    return [result.data as LavalinkTrack];
  }

  if (result.loadType === "search") {
    return result.data as LavalinkTrack[];
  }

  if (result.loadType === "playlist") {
    return (result.data as { tracks: LavalinkTrack[] }).tracks;
  }

  return [];
}

function summarizeSession(session: VoiceSession): DiscordVoiceSessionSnapshot {
  return {
    guildId: session.guildId,
    connected: !session.destroyed,
    voiceChannel: canonicalVoiceChannel(session.voiceChannelId, session.voiceChannelName),
    textChannelId: session.textChannelId,
    currentTrack: session.currentTrack ? summarizeTrack(session.currentTrack) : null,
    queue: session.queue.map(summarizeTrack),
    paused: session.player.paused,
    volume: session.player.volume,
    loopMode: session.loopMode,
    idleLeavesAt: session.idleLeaveAt == null ? null : new Date(session.idleLeaveAt).toISOString()
  };
}

function buildRequesterSnapshot(input: {
  userId: string;
  username: string;
  displayName: string;
  voiceChannelId: string | null;
  voiceChannelName: string | null;
}): DiscordVoiceUserSnapshot {
  return {
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    profileSummary: `${input.displayName} (@${input.username})`,
    voiceChannel: canonicalVoiceChannel(input.voiceChannelId, input.voiceChannelName)
  };
}

function readUserVoiceChannel(guild: Guild, userId: string): { id: string; name: string | null; } | null {
  const voiceState = guild.voiceStates.cache.get(userId);
  if (!voiceState?.channelId) return null;

  return {
    id: voiceState.channelId,
    name: voiceState.channel?.name ?? null
  };
}

function requireUserVoiceChannel(guild: Guild, userId: string): { id: string; name: string | null; } {
  const voiceChannel = readUserVoiceChannel(guild, userId);
  if (!voiceChannel) {
    throw new Error("Join a voice channel first.");
  }

  return voiceChannel;
}

function getGuildSession(sessions: Map<string, VoiceSession>, guildId: string): VoiceSession | null {
  const session = sessions.get(guildId);
  if (!session || session.destroyed) return null;
  return session;
}

function clearIdleTimer(session: VoiceSession): void {
  if (session.idleLeaveAt != null) {
    session.idleLeaveAt = null;
  }

  if (session.idleLeaveTimer != null) {
    clearTimeout(session.idleLeaveTimer);
    session.idleLeaveTimer = null;
  }
}

export function shouldAnnounceIdleLeave(hasStartedPlayback: boolean): boolean {
  return hasStartedPlayback;
}

export function shouldAnnounceQueueEnded(reason: string, hasStartedPlayback: boolean): boolean {
  return reason === "finished" && shouldAnnounceIdleLeave(hasStartedPlayback);
}

function scheduleIdleLeave(
  sessions: Map<string, VoiceSession>,
  session: VoiceSession
): void {
  if (session.destroyed || session.idleLeaveAt != null) return;

  session.idleLeaveAt = Date.now() + IDLE_LEAVE_DELAY_MS;
  const leaveAt = session.idleLeaveAt;

  session.idleLeaveTimer = setTimeout(() => {
    void (async () => {
      const current = sessions.get(session.guildId);
      if (!current || current.destroyed || current.idleLeaveAt !== leaveAt || current.queue.length || current.currentTrack) {
        return;
      }
      await destroySession(sessions, session.guildId);
    })();
  }, IDLE_LEAVE_DELAY_MS);
}

function getLavalinkManager(client: Client, config: BridgeConfig): LavalinkManager {
  if (!lavalinkManager) {
    lavalinkManager = new LavalinkManager(client, config);

    lavalinkManager.on("error", error => {
      console.error("[poke-discord-bridge] Lavalink manager error:", error);
    });
  }

  return lavalinkManager;
}

function getIdealNode(): LavalinkManager | null {
  return lavalinkManager;
}

function selectLoadResultTrack(result: LavalinkSearchResponse): LavalinkTrack | null {
  return extractLoadResultTracks(result)[0] ?? null;
}

function buildTrackFromResolvedLavalinkTrack(
  resolved: LavalinkTrack,
  fallbackTracks: LavalinkTrack[],
  sourceUrl: string,
  requesterId: string,
  requesterDisplayName: string
): VoiceTrack {
  return {
    id: randomUUID(),
    title: resolved.info.title?.trim() || describeUrl(sourceUrl),
    url: resolved.info.uri?.trim() || sourceUrl.trim(),
    encoded: resolved.encoded,
    sourceUrl,
    lengthMs: resolved.info.length ?? 0,
    isSeekable: resolved.info.isSeekable ?? false,
    fallbackTracks,
    requestedByUserId: requesterId,
    requestedByName: requesterDisplayName,
    requestedAt: new Date().toISOString()
  };
}

export function selectFallbackVoiceTrack(track: VoiceTrack): VoiceTrack | null {
  const [nextFallback, ...remainingFallbacks] = track.fallbackTracks;
  if (!nextFallback) return null;

  return {
    ...track,
    title: nextFallback.info.title?.trim() || track.title,
    url: nextFallback.info.uri?.trim() || track.url,
    encoded: nextFallback.encoded,
    lengthMs: nextFallback.info.length ?? track.lengthMs,
    isSeekable: nextFallback.info.isSeekable ?? track.isSeekable,
    fallbackTracks: remainingFallbacks
  };
}

export function isStaleTrackEvent(currentTrack: VoiceTrack | null, eventTrackEncoded?: string | null): boolean {
  return Boolean(currentTrack && eventTrackEncoded && currentTrack.encoded !== eventTrackEncoded);
}

export function normalizeVolume(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 && normalized <= 150 ? normalized : null;
}

export function clampSeekPosition(positionMs: number, trackLengthMs: number): number {
  return Math.max(0, Math.min(Math.trunc(positionMs), trackLengthMs));
}

export function shuffleVoiceQueue<T>(queue: T[], random: () => number = Math.random): T[] {
  const next = [...queue];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex] as T, next[index] as T];
  }
  return next;
}

export function moveVoiceQueueItem<T>(queue: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...queue];
  const [item] = next.splice(fromIndex - 1, 1);
  next.splice(toIndex - 1, 0, item as T);
  return next;
}

async function resolvePlayableTrackForQueue(
  identifier: string,
  sourceTitle: string | null,
  requesterId: string,
  requesterDisplayName: string
): Promise<VoiceTrack> {
  if (!lavalinkManager) {
    throw new Error("Lavalink is not ready.");
  }

  const node = getIdealNode();
  if (!node) {
    throw new Error("Lavalink is not ready.");
  }

  const result = await node.rest.resolve(identifier);
  if (!result) {
    throw new Error("Lavalink is not ready.");
  }

  const track = selectLoadResultTrack(result);
  if (!track) {
    const detail = (() => {
      if (result.loadType === "empty") {
        return "No YouTube matches were returned.";
      }

      if (result.loadType === "error") {
        const errorData = result.data as { message?: string; severity?: string; cause?: string; };
        return errorData.message || errorData.cause || "Lavalink returned an error while resolving the track.";
      }

      return `Lavalink returned loadType=${result.loadType}.`;
    })();
    throw new Error(`Couldn't find a playable version. ${detail} Send a direct link.`);
  }

  const resolvedTracks = extractLoadResultTracks(result);
  return buildTrackFromResolvedLavalinkTrack(
    track,
    resolvedTracks.slice(1),
    sourceTitle ?? identifier,
    requesterId,
    requesterDisplayName
  );
}

function buildSpotifySearchQuery(artist: string, query?: string): string {
  return [artist.trim(), query?.trim()].filter(Boolean).join(" ").trim();
}

function readSpotifyAuthConfig():
  | { clientId: string; clientSecret: string; refreshToken: string; market: string; }
  | null {
  const clientId = process.env.POKE_SPOTIFY_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.POKE_SPOTIFY_CLIENT_SECRET?.trim() || "";
  const refreshToken = process.env.POKE_SPOTIFY_REFRESH_TOKEN?.trim() || "";
  const market = process.env.POKE_SPOTIFY_MARKET?.trim().toUpperCase() || "";

  const anyConfigured = clientId.length || clientSecret.length || refreshToken.length || market.length;
  if (!anyConfigured) return null;
  if (!/^[A-Z]{2}$/.test(market)) {
    throw new Error("POKE_SPOTIFY_MARKET must be a 2-letter country code like US or GB.");
  }
  if (!clientId || !clientSecret || !refreshToken || !market) {
    throw new Error("POKE_SPOTIFY_CLIENT_ID, POKE_SPOTIFY_CLIENT_SECRET, POKE_SPOTIFY_REFRESH_TOKEN, and POKE_SPOTIFY_MARKET must all be set together.");
  }

  return { clientId, clientSecret, refreshToken, market };
}

async function ensureSpotifyAuthConfigured(): Promise<void> {
  if (spotifyTokenSetup) {
    await spotifyTokenSetup;
    return;
  }

  const config = readSpotifyAuthConfig();
  if (!config) {
    spotifyTokenSetup = Promise.resolve();
    return;
  }

  spotifyTokenSetup = Promise.resolve();
  await spotifyTokenSetup;
}

function toMusicSelectionCandidate(track: PlayDlSpotifySearchResultLike): MusicSelectionCandidate {
  return {
    id: track.id,
    url: track.url,
    name: track.name,
    artists: (track.artists ?? []).map(artist => artist.name).filter((artist): artist is string => artist.trim().length > 0)
  };
}

async function createSession(
  client: Client,
  config: BridgeConfig,
  guildId: string,
  voiceChannelId: string,
  voiceChannelName: string | null,
  textChannelId: string | null,
  sessions: Map<string, VoiceSession>,
  announce: (channelId: string, content: string) => Promise<void>,
  runSerializedOperation: <T>(operation: () => Promise<T>) => Promise<T>
): Promise<VoiceSession> {
  const manager = getLavalinkManager(client, config);
  await manager.leaveVoiceChannel(guildId).catch(() => undefined);

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
  const player = await manager.joinVoiceChannel({
    guildId,
    shardId: typeof guild.shardId === "number" ? guild.shardId : 0,
    channelId: voiceChannelId,
    deaf: true
  });

  const session: VoiceSession = {
    guildId,
    voiceChannelId,
    voiceChannelName,
    textChannelId,
    queue: [],
    currentTrack: null,
    hasStartedPlayback: false,
    loopMode: "off",
    idleLeaveAt: null,
    idleLeaveTimer: null,
    player,
    destroyed: false
  };

  sessions.set(guildId, session);

  player.on("start", () => {
    session.hasStartedPlayback = true;
    clearIdleTimer(session);
  });

  player.on("end", event => {
    void runSerializedOperation(() =>
      handleTrackCompletion(
        sessions,
        session,
        announce,
        event.reason,
        typeof event.track?.encoded === "string" ? event.track.encoded : null
      )
    );
  });

  player.on("stuck", event => {
    console.error(`[poke-discord-bridge] Voice track stuck in guild ${guildId}:`, event);
    void runSerializedOperation(() =>
      handleTrackFailure(
        sessions,
        session,
        announce,
        "A track got stuck. Skipping to the next one.",
        typeof event.track?.encoded === "string" ? event.track.encoded : null
      )
    );
  });

  player.on("exception", event => {
    console.error(`[poke-discord-bridge] Voice track exception in guild ${guildId}:`, event);
    void runSerializedOperation(() =>
      handleTrackFailure(
        sessions,
        session,
        announce,
        "A track failed to play. Skipping to the next one.",
        typeof event.track?.encoded === "string" ? event.track.encoded : null
      )
    );
  });

  player.on("closed", event => {
    console.error(`[poke-discord-bridge] Voice player closed in guild ${guildId}:`, event);
    void destroySession(sessions, guildId);
  });

  return session;
}

async function destroySession(sessions: Map<string, VoiceSession>, guildId: string): Promise<void> {
  const session = sessions.get(guildId);
  if (!session || session.destroyed) return;

  session.destroyed = true;
  clearIdleTimer(session);
  session.queue = [];
  session.currentTrack = null;

  try {
    await session.player.destroy();
  } catch {
    // Ignore teardown failures.
  }

  sessions.delete(guildId);
}

export async function handleTrackCompletion(
  sessions: Map<string, VoiceSession>,
  session: VoiceSession,
  announce: (channelId: string, content: string) => Promise<void>,
  reason: string,
  eventTrackEncoded: string | null
): Promise<void> {
  if (session.destroyed) return;
  if (isStaleTrackEvent(session.currentTrack, eventTrackEncoded)) return;

  const finishedTrack = session.currentTrack;
  session.currentTrack = null;

  if (finishedTrack == null) {
    if (!session.queue.length) {
      scheduleIdleLeave(sessions, session);
    }
    return;
  }

  if (reason === "finished" && finishedTrack) {
    if (session.loopMode === "track") {
      session.currentTrack = finishedTrack;
      clearIdleTimer(session);

      try {
        await session.player.playTrack({ track: { encoded: finishedTrack.encoded } });
        return;
      } catch (error) {
        console.error(`[poke-discord-bridge] Failed to replay looped track in guild ${session.guildId}:`, error);
        session.currentTrack = null;
      }
    } else if (session.loopMode === "queue") {
      session.queue.push(finishedTrack);
    }
  }

  if (reason === "stopped" || reason === "finished" || reason === "replaced" || reason === "cleanup") {
    if (session.queue.length) {
      await advanceQueue(sessions, session, announce);
      return;
    }
    if (session.textChannelId && shouldAnnounceQueueEnded(reason, session.hasStartedPlayback)) {
      try {
        await announce(session.textChannelId, "Queue ended. I'll hang out for 5 minutes, then leave if nothing else starts.");
      } catch {
        // Best effort only.
      }
    }
    scheduleIdleLeave(sessions, session);
    return;
  }

  if (session.queue.length) {
    await advanceQueue(sessions, session, announce);
    return;
  }

  scheduleIdleLeave(sessions, session);
}

async function handleTrackFailure(
  sessions: Map<string, VoiceSession>,
  session: VoiceSession,
  announce: (channelId: string, content: string) => Promise<void>,
  message: string,
  eventTrackEncoded: string | null
): Promise<void> {
  if (session.destroyed) return;
  if (isStaleTrackEvent(session.currentTrack, eventTrackEncoded)) return;

  const failedTrack = session.currentTrack;
  session.currentTrack = null;

  const fallbackTrack = failedTrack ? selectFallbackVoiceTrack(failedTrack) : null;
  if (fallbackTrack) {
    session.currentTrack = fallbackTrack;

    try {
      await session.player.playTrack({ track: { encoded: fallbackTrack.encoded } });
      return;
    } catch (error) {
      console.error(`[poke-discord-bridge] Failed to play fallback track in guild ${session.guildId}:`, error);
      session.currentTrack = null;
    }
  }

  if (failedTrack && session.textChannelId) {
    try {
      await announce(session.textChannelId, `${message} ${failedTrack.title}`);
    } catch {
      // Best effort only.
    }
  }

  if (session.queue.length) {
    await advanceQueue(sessions, session, announce);
    return;
  }

  scheduleIdleLeave(sessions, session);
}

async function advanceQueue(
  sessions: Map<string, VoiceSession>,
  session: VoiceSession,
  announce: (channelId: string, content: string) => Promise<void>
): Promise<void> {
  if (session.destroyed || session.currentTrack) return;

  const nextTrack = session.queue.shift() ?? null;
  if (!nextTrack) {
    scheduleIdleLeave(sessions, session);
    return;
  }

  clearIdleTimer(session);
  session.currentTrack = nextTrack;

  try {
    await session.player.playTrack({ track: { encoded: nextTrack.encoded } });
  } catch (error) {
    console.error(`[poke-discord-bridge] Failed to play track in guild ${session.guildId}:`, error);
    session.currentTrack = null;

    if (session.textChannelId) {
      try {
        await announce(session.textChannelId, `I couldn't play ${nextTrack.title}. Skipping it.`);
      } catch {
        // Best effort only.
      }
    }

    if (session.queue.length) {
      await advanceQueue(sessions, session, announce);
      return;
    }

    scheduleIdleLeave(sessions, session);
  }
}

async function queueResolvedTrack(
  client: Client,
  config: BridgeConfig,
  sessions: Map<string, VoiceSession>,
  announce: (channelId: string, content: string) => Promise<void>,
  runSerializedOperation: <T>(operation: () => Promise<T>) => Promise<T>,
  action: "queueVoiceTrack",
  input: Pick<QueueVoiceTrackInput, "bridgeRequestId" | "guildId" | "requesterId" | "requesterDisplayName" | "requesterVoiceChannelId" | "requesterVoiceChannelName" | "textChannelId" | "position">,
  track: VoiceTrack
): Promise<VoiceOperationResult> {
  const guild = client.guilds.cache.get(input.guildId) ?? await client.guilds.fetch(input.guildId);
  const requesterVoice = requireUserVoiceChannel(guild, input.requesterId);
  let session = getGuildSession(sessions, input.guildId);

  if (!session) {
    session = await createSession(client, config, input.guildId, requesterVoice.id, requesterVoice.name, input.textChannelId, sessions, announce, runSerializedOperation);
  }

  if (session.voiceChannelId !== requesterVoice.id) {
    throw new Error(`Poke is already in <#${session.voiceChannelId}>. Join that channel to queue music.`);
  }

  session.textChannelId = input.textChannelId;
  clearIdleTimer(session);

  if (input.position === "front") {
    session.queue.unshift(track);
  } else {
    session.queue.push(track);
  }

  const shouldStart = session.currentTrack == null;
  if (shouldStart) {
    await advanceQueue(sessions, session, announce);
  }

  return {
    ok: true,
    action,
    message: shouldStart ? `Joined <#${session.voiceChannelId}> and started ${track.title}.` : `Queued ${track.title}.`,
    session: queueSnapshot(session),
    track: summarizeTrack(track)
  };
}

function queueSnapshot(session: VoiceSession): DiscordVoiceSessionSnapshot {
  return summarizeSession(session);
}

function getArtistHistory(guildId: string, artist: string): string[] {
  const guildHistory = recentArtistTracksRef.current.get(guildId);
  if (!guildHistory) return [];
  return guildHistory.get(normalizeMusicKey(artist)) ?? [];
}

function rememberArtistTrack(guildId: string, artist: string, trackKey: string): void {
  const artistKey = normalizeMusicKey(artist);
  let guildHistory = recentArtistTracksRef.current.get(guildId);
  if (!guildHistory) {
    guildHistory = new Map<string, string[]>();
    recentArtistTracksRef.current.set(guildId, guildHistory);
  }

  const existing = guildHistory.get(artistKey) ?? [];
  const next = [trackKey, ...existing.filter(entry => entry !== trackKey)].slice(0, ARTIST_HISTORY_LIMIT);
  guildHistory.set(artistKey, next);
}

const sessionsRef = {
  current: new Map<string, VoiceSession>()
};

const recentArtistTracksRef = {
  current: new Map<string, Map<string, string[]>>()
};

const sessionOperationQueueRef = {
  current: new Map<string, Promise<void>>()
};

const ARTIST_HISTORY_LIMIT = 5;

async function runSerializedVoiceOperation<T>(
  operationQueue: Map<string, Promise<void>>,
  guildId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = operationQueue.get(guildId) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);

  let release: (() => void) | undefined;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });

  const queued = waitForPrevious.then(() => current);
  operationQueue.set(guildId, queued);

  try {
    await waitForPrevious;
    return await operation();
  } finally {
    if (release) {
      release();
    }
    if (operationQueue.get(guildId) === queued) {
      operationQueue.delete(guildId);
    }
  }
}

async function resolveArtistTrack(
  client: Client,
  config: BridgeConfig,
  sessions: Map<string, VoiceSession>,
  announce: (channelId: string, content: string) => Promise<void>,
  runSerializedOperation: <T>(operation: () => Promise<T>) => Promise<T>,
  input: QueueVoiceTrackInput,
  requesterVoice: { id: string; name: string | null; }
): Promise<VoiceOperationResult> {
  const searchQuery = buildSpotifySearchQuery(input.artist ?? "", input.query);
  await ensureSpotifyAuthConfigured();
  const spotifyConfig = readSpotifyAuthConfig();
  if (!spotifyConfig) {
    throw new Error("Spotify search is not configured on this VPS. Set the Spotify auth env vars or send a direct link.");
  }

  const searchResults = await searchSpotifyTracks(searchQuery, spotifyConfig, 10);

  const rankedCandidates = rankArtistBoundTracks(
    searchResults.map(toMusicSelectionCandidate),
    input.artist ?? "",
    new Set(getArtistHistory(input.guildId, input.artist ?? ""))
  );

  if (!rankedCandidates.length) {
    throw new Error("Couldn't find a playable version. Send a direct link.");
  }

  let lastError: unknown = null;
  for (const candidate of rankedCandidates) {
    try {
      const identifier = buildSpotifyTrackSearchIdentifier({
        id: candidate.id,
        name: candidate.name,
        url: candidate.url,
        artists: candidate.artists.map(name => ({ name }))
      });
      const track = await resolvePlayableTrackForQueue(identifier, candidate.name, input.requesterId, input.requesterDisplayName);
      const result = await queueResolvedTrack(client, config, sessions, announce, runSerializedOperation, "queueVoiceTrack", {
        bridgeRequestId: input.bridgeRequestId,
        guildId: input.guildId,
        requesterId: input.requesterId,
        requesterDisplayName: input.requesterDisplayName,
        requesterVoiceChannelId: requesterVoice.id,
        requesterVoiceChannelName: requesterVoice.name,
        textChannelId: input.textChannelId,
        position: input.position
      }, track);
      rememberArtistTrack(input.guildId, input.artist ?? "", candidate.url);
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  console.error(`[poke-discord-bridge] No playable track found for artist "${input.artist}" in guild ${input.guildId}:`, lastError);
  throw new Error("Couldn't find a playable version. Send a direct link.");
}

function buildVoiceContext(
  guild: Guild | null | undefined,
  requester: { userId: string; username: string; displayName: string; },
  sessions: Map<string, VoiceSession>
): DiscordVoiceContext | null {
  if (!guild) return null;

  const requesterVoice = readUserVoiceChannel(guild, requester.userId);
  const session = getGuildSession(sessions, guild.id);

  return {
    requester: buildRequesterSnapshot({
      userId: requester.userId,
      username: requester.username,
      displayName: requester.displayName,
      voiceChannelId: requesterVoice?.id ?? null,
      voiceChannelName: requesterVoice?.name ?? null
    }),
    bot: session ? queueSnapshot(session) : null
  };
}

async function ensureSessionVoiceMatch(session: VoiceSession, requesterVoice: { id: string; name: string | null; } | null): Promise<void> {
  if (!requesterVoice || session.voiceChannelId !== requesterVoice.id) {
    throw new Error(`Poke is in <#${session.voiceChannelId}>. Join that channel to control playback.`);
  }
}

async function controlVoicePlaybackImpl(
  client: Client,
  config: BridgeConfig,
  sessions: Map<string, VoiceSession>,
  announce: (channelId: string, content: string) => Promise<void>,
  runSerializedOperation: <T>(operation: () => Promise<T>) => Promise<T>,
  input: ControlVoicePlaybackInput
): Promise<VoiceOperationResult> {
  const guild = client.guilds.cache.get(input.guildId) ?? await client.guilds.fetch(input.guildId);
  const requesterVoice = input.requesterId ? readUserVoiceChannel(guild, input.requesterId) : null;
  const existingSession = getGuildSession(sessions, input.guildId);

  if (input.action !== "join" && !existingSession) {
    throw new Error("Poke is not in a voice channel in this server.");
  }

  if (input.action !== "join") {
    await ensureSessionVoiceMatch(existingSession as VoiceSession, requesterVoice);
  } else if (existingSession && requesterVoice && existingSession.voiceChannelId !== requesterVoice.id) {
    throw new Error(`Poke is in <#${existingSession.voiceChannelId}>. Join that channel to control playback.`);
  }

  let session = existingSession;
  if (input.action === "join") {
    if (!requesterVoice) {
      throw new Error("Join a voice channel first.");
    }

    if (!session) {
      session = await createSession(client, config, input.guildId, requesterVoice.id, requesterVoice.name, input.textChannelId, sessions, announce, runSerializedOperation);
    }
  }

  if (!session) {
    throw new Error("Poke is not in a voice channel in this server.");
  }

  session.textChannelId = input.textChannelId;

  switch (input.action) {
    case "join":
      return {
        ok: true,
        action: "join",
        message: `Ready in <#${session.voiceChannelId}>.`,
        session: queueSnapshot(session)
      };
    case "pause":
      if (session.player.paused) {
        return { ok: true, action: "pause", message: "Already paused.", session: queueSnapshot(session) };
      }
      await session.player.setPaused(true);
      return { ok: true, action: "pause", message: "Paused playback.", session: queueSnapshot(session) };
    case "resume":
      if (!session.player.paused) {
        return { ok: true, action: "resume", message: "Playback is not paused.", session: queueSnapshot(session) };
      }
      await session.player.setPaused(false);
      return { ok: true, action: "resume", message: "Resumed playback.", session: queueSnapshot(session) };
    case "skip":
      if (!session.currentTrack) {
        return { ok: true, action: "skip", message: "Nothing is playing.", session: queueSnapshot(session) };
      }
      // Don't rely on Lavalink's end event for the user-facing state transition.
      await session.player.stopTrack();
      await handleTrackCompletion(
        sessions,
        session,
        announce,
        "stopped",
        session.currentTrack.encoded
      );
      return { ok: true, action: "skip", message: "Skipped the current track.", session: queueSnapshot(session) };
    case "stop":
    case "leave":
      await destroySession(sessions, input.guildId);
      return { ok: true, action: input.action, message: "Left the voice channel and cleared playback.", session: null };
    case "current":
      return {
        ok: true,
        action: "current",
        message: session.currentTrack ? `Now playing ${session.currentTrack.title}.` : "Nothing is playing.",
        session: queueSnapshot(session),
        track: session.currentTrack ? summarizeTrack(session.currentTrack) : null
      };
    case "queue":
      return {
        ok: true,
        action: "queue",
        message: session.queue.length ? `There are ${session.queue.length} track${session.queue.length === 1 ? "" : "s"} queued.` : "The queue is empty.",
        session: queueSnapshot(session)
      };
    case "volume": {
      const volume = normalizeVolume(input.value ?? Number.NaN);
      if (volume == null) {
        throw new Error("value is required for volume and must be an integer between 0 and 150.");
      }
      await session.player.setVolume(volume);
      return {
        ok: true,
        action: "volume",
        message: `Set volume to ${volume}%.`,
        session: queueSnapshot(session)
      };
    }
    case "seek": {
      const positionMs = input.positionMs;
      if (positionMs == null || !Number.isFinite(positionMs)) {
        throw new Error("positionMs is required.");
      }
      if (!session.currentTrack) {
        throw new Error("Nothing is playing.");
      }
      if (!session.currentTrack.isSeekable) {
        throw new Error("The current track cannot be seeked.");
      }
      const targetPosition = clampSeekPosition(positionMs, session.currentTrack.lengthMs);
      await session.player.seekTo(targetPosition);
      return {
        ok: true,
        action: "seek",
        message: `Seeked to ${Math.floor(targetPosition / 1000)}s in ${session.currentTrack.title}.`,
        session: queueSnapshot(session),
        track: summarizeTrack(session.currentTrack)
      };
    }
    case "shuffle":
      if (session.queue.length < 2) {
        return {
          ok: true,
          action: "shuffle",
          message: "There isn't enough queued music to shuffle.",
          session: queueSnapshot(session)
        };
      }
      session.queue = shuffleVoiceQueue(session.queue);
      return {
        ok: true,
        action: "shuffle",
        message: "Shuffled the queue.",
        session: queueSnapshot(session)
      };
    case "loop": {
      const loopMode = input.loopMode;
      if (loopMode !== "off" && loopMode !== "track" && loopMode !== "queue") {
        throw new Error("loopMode must be off, track, or queue.");
      }
      session.loopMode = loopMode;
      return {
        ok: true,
        action: "loop",
        message: loopMode === "off" ? "Looping is off." : loopMode === "track" ? "Looping the current track." : "Looping the queue.",
        session: queueSnapshot(session)
      };
    }
    case "remove": {
      const index = input.index;
      if (index == null || !Number.isInteger(index) || index < 1 || index > session.queue.length) {
        throw new Error("index must point to a queued track.");
      }
      const [removed] = session.queue.splice(index - 1, 1);
      return {
        ok: true,
        action: "remove",
        message: `Removed ${removed.title} from the queue.`,
        session: queueSnapshot(session),
        removedTrack: summarizeTrack(removed)
      };
    }
    case "move": {
      const fromIndex = input.fromIndex;
      const toIndex = input.toIndex;
      if (fromIndex == null || toIndex == null || !Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
        throw new Error("fromIndex and toIndex are required.");
      }
      if (fromIndex < 1 || fromIndex > session.queue.length || toIndex < 1 || toIndex > session.queue.length) {
        throw new Error("fromIndex and toIndex must point to queued tracks.");
      }
      if (fromIndex === toIndex) {
        throw new Error("fromIndex and toIndex must be different.");
      }
      session.queue = moveVoiceQueueItem(session.queue, fromIndex, toIndex);
      return {
        ok: true,
        action: "move",
        message: `Moved queue item ${fromIndex} to ${toIndex}.`,
        session: queueSnapshot(session)
      };
    }
    case "clear": {
      const removedCount = session.queue.length;
      session.queue = [];
      return {
        ok: true,
        action: "clear",
        message: removedCount ? `Cleared ${removedCount} queued track${removedCount === 1 ? "" : "s"}.` : "The queue is already empty.",
        session: queueSnapshot(session)
      };
    }
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }
}

export function createVoiceManager(
  client: Client,
  config: BridgeConfig,
  announce: (channelId: string, content: string) => Promise<void>
): VoiceManager {
  const sessions = sessionsRef.current;
  const operationQueue = sessionOperationQueueRef.current;
  getLavalinkManager(client, config);

  return {
    describeVoiceContext(guildId, requester) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return null;

      return buildVoiceContext(guild, requester, sessions);
    },

    async queueVoiceTrack(input) {
      return runSerializedVoiceOperation(operationQueue, input.guildId, async () => {
        const guild = client.guilds.cache.get(input.guildId) ?? await client.guilds.fetch(input.guildId);
        const requesterVoice = requireUserVoiceChannel(guild, input.requesterId);
        const runSessionOperation = <T>(operation: () => Promise<T>) =>
          runSerializedVoiceOperation(operationQueue, input.guildId, operation);

        if (input.artist?.trim()) {
          return resolveArtistTrack(client, config, sessions, announce, runSessionOperation, input, requesterVoice);
        }

        if (!input.url?.trim()) {
          throw new Error("url is required");
        }

        const spotifyConfig = input.url.includes("spotify.com/track/") || input.url.startsWith("spotify:track:")
          ? readSpotifyAuthConfig()
          : null;
        const identifier = await resolveLavalinkTrackIdentifier(input.url, spotifyConfig);
        const track = await resolvePlayableTrackForQueue(identifier, null, input.requesterId, input.requesterDisplayName);

        return queueResolvedTrack(client, config, sessions, announce, runSessionOperation, "queueVoiceTrack", {
          bridgeRequestId: input.bridgeRequestId,
          guildId: input.guildId,
          requesterId: input.requesterId,
          requesterDisplayName: input.requesterDisplayName,
          requesterVoiceChannelId: requesterVoice.id,
          requesterVoiceChannelName: requesterVoice.name,
          textChannelId: input.textChannelId,
          position: input.position
        }, track);
      });
    },

    async controlVoicePlayback(input) {
      return runSerializedVoiceOperation(operationQueue, input.guildId, async () => {
        const runSessionOperation = <T>(operation: () => Promise<T>) =>
          runSerializedVoiceOperation(operationQueue, input.guildId, operation);
        return controlVoicePlaybackImpl(client, config, sessions, announce, runSessionOperation, input);
      });
    },

    getSessionSnapshot(guildId) {
      const session = getGuildSession(sessions, guildId);
      return session ? queueSnapshot(session) : null;
    }
  };
}
