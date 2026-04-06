import type { DiscordRelayRequest } from "./types";
import type { ControlVoicePlaybackInput, QueueVoiceTrackInput } from "./voice";

type QueueVoiceTrackRequestMeta = {
  bridgeRequestId: string;
  url?: string;
  artist?: string;
  query?: string;
  position: "front" | "back";
};

type ControlVoicePlaybackRequestMeta = {
  bridgeRequestId: string;
  action: ControlVoicePlaybackInput["action"];
  index?: number;
  value?: number;
  positionMs?: number;
  loopMode?: ControlVoicePlaybackInput["loopMode"];
  fromIndex?: number;
  toIndex?: number;
};

export function buildQueueVoiceTrackRequest(
  request: DiscordRelayRequest,
  meta: QueueVoiceTrackRequestMeta
): QueueVoiceTrackInput {
  return {
    bridgeRequestId: meta.bridgeRequestId,
    guildId: request.tenant.id,
    requesterId: request.discordUserId,
    requesterUsername: request.voiceContext?.requester.username ?? request.discordUserId,
    requesterDisplayName: request.voiceContext?.requester.displayName ?? request.discordUserId,
    requesterVoiceChannelId: request.voiceContext?.requester.voiceChannel.id ?? "",
    requesterVoiceChannelName: request.voiceContext?.requester.voiceChannel.name ?? null,
    textChannelId: request.replyTarget.channelId,
    url: meta.url,
    artist: meta.artist,
    query: meta.query,
    position: meta.position
  };
}

export function buildControlVoicePlaybackRequest(
  request: DiscordRelayRequest,
  meta: ControlVoicePlaybackRequestMeta
): ControlVoicePlaybackInput {
  return {
    bridgeRequestId: meta.bridgeRequestId,
    guildId: request.tenant.id,
    requesterId: request.discordUserId,
    requesterUsername: request.voiceContext?.requester.username ?? request.discordUserId,
    requesterDisplayName: request.voiceContext?.requester.displayName ?? request.discordUserId,
    requesterVoiceChannelId: request.voiceContext?.requester.voiceChannel.id ?? null,
    requesterVoiceChannelName: request.voiceContext?.requester.voiceChannel.name ?? null,
    textChannelId: request.replyTarget.channelId,
    action: meta.action,
    ...(meta.index == null ? {} : { index: meta.index }),
    ...(meta.value == null ? {} : { value: meta.value }),
    ...(meta.positionMs == null ? {} : { positionMs: meta.positionMs }),
    ...(meta.loopMode == null ? {} : { loopMode: meta.loopMode }),
    ...(meta.fromIndex == null ? {} : { fromIndex: meta.fromIndex }),
    ...(meta.toIndex == null ? {} : { toIndex: meta.toIndex })
  };
}
