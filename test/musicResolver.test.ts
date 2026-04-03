import { expect, test } from "bun:test";

import { resolvePlayableTrackUrl } from "../src/musicResolver";

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
