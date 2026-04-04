type PlayDlSpotifyTrackLike = {
  type: "track" | "playlist" | "album";
  name: string;
  url: string;
  artists?: { name: string }[];
};

export type PlayDlLike = {
  yt_validate(url: string): "playlist" | "video" | "search" | false;
  sp_validate(url: string): "track" | "playlist" | "album" | "search" | false;
  spotify(url: string): Promise<PlayDlSpotifyTrackLike>;
};

function buildSpotifySearchQuery(track: PlayDlSpotifyTrackLike): string {
  const artists = track.artists?.map(artist => artist.name.trim()).filter(Boolean).join(" ") ?? "";
  return [track.name.trim(), artists].filter(Boolean).join(" ").trim();
}

export async function resolveLavalinkTrackIdentifier(playDl: PlayDlLike, url: string): Promise<string> {
  if (playDl.yt_validate(url) === "video") {
    return url;
  }

  if (playDl.sp_validate(url) === "track") {
    const track = await playDl.spotify(url);
    if (track.type !== "track") {
      throw new Error("Only Spotify track URLs are supported.");
    }
    return `ytsearch:${buildSpotifySearchQuery(track)}`;
  }

  throw new Error("Only YouTube video URLs or Spotify track URLs are supported.");
}
