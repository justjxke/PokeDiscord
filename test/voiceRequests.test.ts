import { describe, expect, test } from "bun:test";

import type { DiscordRelayRequest } from "../src/types";
import { buildControlVoicePlaybackRequest, buildQueueVoiceTrackRequest } from "../src/voiceRequests";

const request: DiscordRelayRequest = {
  bridgeRequestId: "bridge-1",
  tenant: {
    kind: "guild",
    id: "guild-1"
  },
  discordUserId: "user-1",
  discordChannelId: "channel-1",
  discordMessageId: "message-1",
  mode: "guild" as const,
  prompt: "play something",
  replyTarget: {
    channelId: "reply-channel-1",
    label: "music",
    mode: "guild",
    createdAt: 1
  },
  attachments: [],
  contextMessages: [],
  voiceContext: {
    requester: {
      userId: "user-1",
      username: "jake",
      displayName: "Jake",
      profileSummary: "Jake (@jake)",
      voiceChannel: {
        id: "voice-1",
        name: "Music"
      }
    },
    bot: null
  }
};

describe("buildQueueVoiceTrackRequest", () => {
  test("copies the queue voice fields into the worker payload", () => {
    expect(
      buildQueueVoiceTrackRequest(request, {
        bridgeRequestId: "bridge-1",
        artist: "Daft Punk",
        query: "Get Lucky",
        position: "front"
      })
    ).toEqual({
      bridgeRequestId: "bridge-1",
      guildId: "guild-1",
      requesterId: "user-1",
      requesterUsername: "jake",
      requesterDisplayName: "Jake",
      requesterVoiceChannelId: "voice-1",
      requesterVoiceChannelName: "Music",
      textChannelId: "reply-channel-1",
      artist: "Daft Punk",
      query: "Get Lucky",
      position: "front"
    });
  });
});

describe("buildControlVoicePlaybackRequest", () => {
  test("copies every voice control field into the worker payload", () => {
    expect(
      buildControlVoicePlaybackRequest(request, {
        bridgeRequestId: "bridge-1",
        action: "move",
        index: 3,
        value: 42,
        positionMs: 90000,
        loopMode: "queue",
        fromIndex: 2,
        toIndex: 1
      })
    ).toEqual({
      bridgeRequestId: "bridge-1",
      guildId: "guild-1",
      requesterId: "user-1",
      requesterUsername: "jake",
      requesterDisplayName: "Jake",
      requesterVoiceChannelId: "voice-1",
      requesterVoiceChannelName: "Music",
      textChannelId: "reply-channel-1",
      action: "move",
      index: 3,
      value: 42,
      positionMs: 90000,
      loopMode: "queue",
      fromIndex: 2,
      toIndex: 1
    });
  });
});
