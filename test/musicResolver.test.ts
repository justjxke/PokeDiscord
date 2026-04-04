import { expect, test } from "bun:test";

import { resolvePlayableTrackUrl } from "../src/musicResolver";
import { normalizeMusicKey, rankArtistBoundTracks, selectArtistBoundTrack } from "../src/musicSelection";

test("resolves a spotify track to the first playable youtube result", async () => {
  const playDl = {
    yt_validate: (url: string): "video" | false => (url.startsWith("https://youtube.com/watch") ? "video" : false),
    sp_validate: (url: string): "track" | false => (url.startsWith("https://open.spotify.com/track") ? "track" : false),
    spotify: async () => ({
      type: "track" as const,
      name: "Locked Out of Heaven",
      url: "https://open.spotify.com/track/example",
      artists: [{ name: "Bruno Mars" }]
    }),
    search: async () => [{ url: "https://youtube.com/watch?v=abc123", title: "Bruno Mars - Locked Out of Heaven" }]
  };

  const resolved = await resolvePlayableTrackUrl(playDl, "https://open.spotify.com/track/example");

  expect(resolved.kind).toBe("youtube");
  expect(resolved.url).toBe("https://youtube.com/watch?v=abc123");
});

test("asks for a direct link when spotify has no playable match", async () => {
  const playDl = {
    yt_validate: (): false => false,
    sp_validate: (url: string): "track" | false => (url.startsWith("https://open.spotify.com/track") ? "track" : false),
    spotify: async () => ({
      type: "track" as const,
      name: "Locked Out of Heaven",
      url: "https://open.spotify.com/track/example",
      artists: [{ name: "Bruno Mars" }]
    }),
    search: async () => []
  };

  await expect(resolvePlayableTrackUrl(playDl, "https://open.spotify.com/track/example")).rejects.toThrow(
    "Couldn't find a playable version. Send a direct link."
  );
});

test("selects the first non-recent track by the requested artist", () => {
  const picked = selectArtistBoundTrack(
    [
      { id: "1", url: "https://spotify/1", name: "Song One", artists: ["Bruno Mars"] },
      { id: "2", url: "https://spotify/2", name: "Song Two", artists: ["Bruno Mars"] },
      { id: "3", url: "https://spotify/3", name: "Song Three", artists: ["Mark Ronson"] }
    ],
    "Bruno Mars",
    new Set([normalizeMusicKey("https://spotify/1")])
  );

  expect(picked?.url).toBe("https://spotify/2");
});

test("returns null when no candidate matches the requested artist", () => {
  const picked = selectArtistBoundTrack(
    [
      { id: "1", url: "https://spotify/1", name: "Song One", artists: ["Mark Ronson"] }
    ],
    "Bruno Mars",
    new Set()
  );

  expect(picked).toBeNull();
});

test("keeps matching tracks in order and pushes recent tracks to the end", () => {
  const ranked = rankArtistBoundTracks(
    [
      { id: "1", url: "https://spotify/1", name: "Song One", artists: ["Bruno Mars"] },
      { id: "2", url: "https://spotify/2", name: "Song Two", artists: ["Bruno Mars"] },
      { id: "3", url: "https://spotify/3", name: "Song Three", artists: ["Bruno Mars"] }
    ],
    "Bruno Mars",
    new Set([normalizeMusicKey("https://spotify/1"), normalizeMusicKey("https://spotify/3")])
  );

  expect(ranked.map(track => track.url)).toEqual([
    "https://spotify/2",
    "https://spotify/1",
    "https://spotify/3"
  ]);
});
