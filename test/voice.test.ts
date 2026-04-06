import { describe, expect, test } from "bun:test";

import {
  clampSeekPosition,
  handleTrackCompletion,
  handleTrackFailure,
  shouldAnnounceQueueEnded,
  isStaleTrackEvent,
  moveVoiceQueueItem,
  normalizeVolume,
  selectFallbackVoiceTrack,
  shouldAnnounceIdleLeave,
  shuffleVoiceQueue
} from "../src/voice";

describe("selectFallbackVoiceTrack", () => {
  test("promotes the next lavalink fallback track and preserves the remaining fallbacks", () => {
    const fallback = selectFallbackVoiceTrack({
      id: "voice-track-1",
      title: "Primary Track",
      url: "https://www.youtube.com/watch?v=primary",
      encoded: "encoded-primary",
      sourceUrl: "ytsearch:test query",
      lengthMs: 1000,
      isSeekable: true,
      fallbackTracks: [
        {
          encoded: "encoded-fallback-1",
          info: {
            identifier: "fallback-1",
            isSeekable: true,
            author: "Artist",
            length: 1000,
            isStream: false,
            position: 0,
            title: "Fallback One",
            uri: "https://www.youtube.com/watch?v=fallback1",
            sourceName: "youtube",
            artworkUrl: null,
            isrc: null
          },
          pluginInfo: {}
        },
        {
          encoded: "encoded-fallback-2",
          info: {
            identifier: "fallback-2",
            isSeekable: true,
            author: "Artist",
            length: 1000,
            isStream: false,
            position: 0,
            title: "Fallback Two",
            uri: "https://www.youtube.com/watch?v=fallback2",
            sourceName: "youtube",
            artworkUrl: null,
            isrc: null
          },
          pluginInfo: {}
        }
      ],
      requestedByUserId: "user-1",
      requestedByName: "Jake",
      requestedAt: "2026-04-05T16:00:00.000Z"
    });

    expect(fallback).not.toBeNull();
    expect(fallback?.encoded).toBe("encoded-fallback-1");
    expect(fallback?.title).toBe("Fallback One");
    expect(fallback?.url).toBe("https://www.youtube.com/watch?v=fallback1");
    expect(fallback?.fallbackTracks).toHaveLength(1);
    expect(fallback?.fallbackTracks[0]?.encoded).toBe("encoded-fallback-2");
  });

  test("returns null when no fallback candidates remain", () => {
    const fallback = selectFallbackVoiceTrack({
      id: "voice-track-2",
      title: "Only Track",
      url: "https://www.youtube.com/watch?v=only",
      encoded: "encoded-only",
      sourceUrl: "ytsearch:test query",
      lengthMs: 1000,
      isSeekable: true,
      fallbackTracks: [],
      requestedByUserId: "user-1",
      requestedByName: "Jake",
      requestedAt: "2026-04-05T16:00:00.000Z"
    });

    expect(fallback).toBeNull();
  });
});

describe("isStaleTrackEvent", () => {
  test("returns true when a lavalink event targets a replaced track", () => {
    expect(
      isStaleTrackEvent(
        {
          id: "voice-track-3",
          title: "Fallback Track",
          url: "https://www.youtube.com/watch?v=fallback",
          encoded: "encoded-fallback",
          sourceUrl: "ytsearch:test query",
          lengthMs: 1000,
          isSeekable: true,
          fallbackTracks: [],
          requestedByUserId: "user-1",
          requestedByName: "Jake",
          requestedAt: "2026-04-05T16:00:00.000Z"
        },
        "encoded-original"
      )
    ).toBe(true);
  });

  test("returns false when the lavalink event matches the current track", () => {
    expect(
      isStaleTrackEvent(
        {
          id: "voice-track-4",
          title: "Current Track",
          url: "https://www.youtube.com/watch?v=current",
          encoded: "encoded-current",
          sourceUrl: "ytsearch:test query",
          lengthMs: 1000,
          isSeekable: true,
          fallbackTracks: [],
          requestedByUserId: "user-1",
          requestedByName: "Jake",
          requestedAt: "2026-04-05T16:00:00.000Z"
        },
        "encoded-current"
      )
    ).toBe(false);
  });
});

describe("normalizeVolume", () => {
  test("accepts integer values within the supported range", () => {
    expect(normalizeVolume(0)).toBe(0);
    expect(normalizeVolume(150)).toBe(150);
    expect(normalizeVolume(87.9)).toBe(87);
  });

  test("rejects values outside the supported range", () => {
    expect(normalizeVolume(-1)).toBeNull();
    expect(normalizeVolume(151)).toBeNull();
    expect(normalizeVolume(Number.NaN)).toBeNull();
  });
});

describe("clampSeekPosition", () => {
  test("clamps seek targets to the track duration", () => {
    expect(clampSeekPosition(-1000, 120000)).toBe(0);
    expect(clampSeekPosition(121000, 120000)).toBe(120000);
    expect(clampSeekPosition(45555, 120000)).toBe(45555);
  });
});

describe("shuffleVoiceQueue", () => {
  test("shuffles queued tracks without changing membership", () => {
    const shuffled = shuffleVoiceQueue(["a", "b", "c", "d"], () => 0);
    expect(shuffled).toEqual(["b", "c", "d", "a"]);
    expect([...shuffled].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("moveVoiceQueueItem", () => {
  test("moves a queued track between 1-based positions", () => {
    expect(moveVoiceQueueItem(["a", "b", "c", "d"], 4, 2)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("shouldAnnounceIdleLeave", () => {
  test("stays quiet before any track has started", () => {
    expect(shouldAnnounceIdleLeave(false)).toBe(false);
  });

  test("announces once a session has played at least one track", () => {
    expect(shouldAnnounceIdleLeave(true)).toBe(true);
  });
});

describe("shouldAnnounceQueueEnded", () => {
  test("announces only for a real finished track after playback has started", () => {
    expect(shouldAnnounceQueueEnded("finished", true)).toBe(true);
    expect(shouldAnnounceQueueEnded("finished", false)).toBe(false);
    expect(shouldAnnounceQueueEnded("replaced", true)).toBe(false);
    expect(shouldAnnounceQueueEnded("stopped", true)).toBe(false);
  });
});

describe("handleTrackCompletion", () => {
  test("advances to the next queued track when skip stops the current track", async () => {
    const playedTracks: string[] = [];
    const session = {
      destroyed: false,
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      voiceChannelName: "Music",
      textChannelId: null,
      queue: [
        {
          id: "voice-track-next",
          title: "Next Track",
          url: "https://www.youtube.com/watch?v=next",
          encoded: "encoded-next",
          sourceUrl: "ytsearch:next",
          lengthMs: 1000,
          isSeekable: true,
          fallbackTracks: [],
          requestedByUserId: "user-1",
          requestedByName: "Jake",
          requestedAt: "2026-04-05T16:00:00.000Z"
        }
      ],
      currentTrack: {
        id: "voice-track-current",
        title: "Current Track",
        url: "https://www.youtube.com/watch?v=current",
        encoded: "encoded-current",
        sourceUrl: "ytsearch:current",
        lengthMs: 1000,
        isSeekable: true,
        fallbackTracks: [],
        requestedByUserId: "user-1",
        requestedByName: "Jake",
        requestedAt: "2026-04-05T16:00:00.000Z"
      },
      hasStartedPlayback: true,
      loopMode: "off" as const,
      idleLeaveAt: null,
      idleLeaveTimer: null,
      player: {
        paused: false,
        volume: 100,
        playTrack: async ({ track }: { track: { encoded: string } }) => {
          playedTracks.push(track.encoded);
        }
      }
    };

    await handleTrackCompletion(new Map([["guild-1", session as never]]), session as never, async () => {}, "stopped", "encoded-current");

    expect(playedTracks).toEqual(["encoded-next"]);
    expect(session.currentTrack?.encoded).toBe("encoded-next");
    expect(session.queue).toHaveLength(0);
  });

  test("restarts the current track from the beginning when loop mode is track", async () => {
    const playedTracks: Array<{ track: { encoded: string }; position?: number }> = [];
    const session = {
      destroyed: false,
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      voiceChannelName: "Music",
      textChannelId: null,
      queue: [
        {
          id: "voice-track-next",
          title: "Next Track",
          url: "https://www.youtube.com/watch?v=next",
          encoded: "encoded-next",
          sourceUrl: "ytsearch:next",
          lengthMs: 1000,
          isSeekable: true,
          fallbackTracks: [],
          requestedByUserId: "user-1",
          requestedByName: "Jake",
          requestedAt: "2026-04-05T16:00:00.000Z"
        }
      ],
      currentTrack: {
        id: "voice-track-current",
        title: "Current Track",
        url: "https://www.youtube.com/watch?v=current",
        encoded: "encoded-current",
        sourceUrl: "ytsearch:current",
        lengthMs: 1000,
        isSeekable: true,
        fallbackTracks: [],
        requestedByUserId: "user-1",
        requestedByName: "Jake",
        requestedAt: "2026-04-05T16:00:00.000Z"
      },
      hasStartedPlayback: true,
      loopMode: "track" as const,
      idleLeaveAt: null,
      idleLeaveTimer: null,
      player: {
        paused: false,
        volume: 100,
        playTrack: async (payload: { track: { encoded: string }; position?: number }) => {
          playedTracks.push(payload);
        }
      }
    };

    await handleTrackCompletion(new Map([["guild-1", session as never]]), session as never, async () => {}, "finished", "encoded-current");

    expect(playedTracks).toEqual([{ track: { encoded: "encoded-current" }, position: 0 }]);
    expect(session.currentTrack?.encoded).toBe("encoded-current");
    expect(session.queue).toHaveLength(1);
  });
});

describe("handleTrackFailure", () => {
  test("restarts the current track instead of advancing the queue when loop mode is track", async () => {
    const playedTracks: Array<{ track: { encoded: string }; position?: number }> = [];
    const session = {
      destroyed: false,
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      voiceChannelName: "Music",
      textChannelId: null,
      queue: [
        {
          id: "voice-track-next",
          title: "Next Track",
          url: "https://www.youtube.com/watch?v=next",
          encoded: "encoded-next",
          sourceUrl: "ytsearch:next",
          lengthMs: 1000,
          isSeekable: true,
          fallbackTracks: [],
          requestedByUserId: "user-1",
          requestedByName: "Jake",
          requestedAt: "2026-04-05T16:00:00.000Z"
        }
      ],
      currentTrack: {
        id: "voice-track-current",
        title: "Current Track",
        url: "https://www.youtube.com/watch?v=current",
        encoded: "encoded-current",
        sourceUrl: "ytsearch:current",
        lengthMs: 1000,
        isSeekable: true,
        fallbackTracks: [],
        requestedByUserId: "user-1",
        requestedByName: "Jake",
        requestedAt: "2026-04-05T16:00:00.000Z"
      },
      hasStartedPlayback: true,
      loopMode: "track" as const,
      idleLeaveAt: null,
      idleLeaveTimer: null,
      player: {
        paused: false,
        volume: 100,
        playTrack: async (payload: { track: { encoded: string }; position?: number }) => {
          playedTracks.push(payload);
        }
      }
    };

    await handleTrackFailure(new Map([["guild-1", session as never]]), session as never, async () => {}, "A track failed to play. Skipping to the next one.", "encoded-current");

    expect(playedTracks).toEqual([{ track: { encoded: "encoded-current" }, position: 0 }]);
    expect(session.currentTrack?.encoded).toBe("encoded-current");
    expect(session.queue).toHaveLength(1);
  });
});
