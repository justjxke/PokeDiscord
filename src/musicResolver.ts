type PlayDlSpotifyTrackLike = {
  type: "track" | "playlist" | "album";
  name: string;
  url: string;
  artists?: { name: string }[];
};

type PlayDlSearchResultLike = {
  url?: string;
  title?: string;
};

export type PlayDlLike = {
  yt_validate(url: string): "playlist" | "video" | "search" | false;
  sp_validate(url: string): "track" | "playlist" | "album" | "search" | false;
  spotify(url: string): Promise<PlayDlSpotifyTrackLike>;
  search(query: string, options: { source: { youtube: "video" }; limit?: number }): Promise<PlayDlSearchResultLike[]>;
};

export interface ResolvedPlayableUrl {
  kind: "youtube";
  url: string;
}

function buildSpotifySearchQuery(track: PlayDlSpotifyTrackLike): string {
  const artists = track.artists?.map(artist => artist.name.trim()).filter(Boolean).join(" ") ?? "";
  return [track.name.trim(), artists].filter(Boolean).join(" ").trim();
}

function findPlayableSearchResult(results: PlayDlSearchResultLike[]): string | null {
  for (const result of results) {
    const candidate = typeof result.url === "string" ? result.url.trim() : "";
    if (candidate.length) return candidate;
  }

  return null;
}

export async function resolvePlayableTrackUrl(playDl: PlayDlLike, url: string): Promise<ResolvedPlayableUrl> {
  if (playDl.yt_validate(url) === "video") {
    return { kind: "youtube", url };
  }

  if (playDl.sp_validate(url) === "track") {
    const track = await playDl.spotify(url);
    if (track.type !== "track") {
      throw new Error("Only Spotify track URLs are supported.");
    }
    const searchQuery = buildSpotifySearchQuery(track);
    const results = await playDl.search(searchQuery, {
      source: { youtube: "video" },
      limit: 10
    });
    const playableUrl = findPlayableSearchResult(results);
    if (!playableUrl) {
      throw new Error("Couldn't find a playable version. Send a direct link.");
    }

    return { kind: "youtube", url: playableUrl };
  }

  throw new Error("Only YouTube video URLs or Spotify track URLs are supported.");
}
