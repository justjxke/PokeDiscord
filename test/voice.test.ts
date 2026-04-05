import { describe, expect, test } from "bun:test";

import { selectFallbackVoiceTrack } from "../src/voice";

describe("selectFallbackVoiceTrack", () => {
  test("promotes the next lavalink fallback track and preserves the remaining fallbacks", () => {
    const fallback = selectFallbackVoiceTrack({
      id: "voice-track-1",
      title: "Primary Track",
      url: "https://www.youtube.com/watch?v=primary",
      encoded: "encoded-primary",
      sourceUrl: "ytsearch:test query",
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
      fallbackTracks: [],
      requestedByUserId: "user-1",
      requestedByName: "Jake",
      requestedAt: "2026-04-05T16:00:00.000Z"
    });

    expect(fallback).toBeNull();
  });
});
