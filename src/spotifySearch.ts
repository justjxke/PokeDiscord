export interface SpotifyAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  market: string;
}

export interface SpotifySearchTrack {
  id?: string;
  name: string;
  url: string;
  artists?: { name: string }[];
}

interface CachedSpotifyToken {
  configFingerprint: string;
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

let cachedSpotifyToken: CachedSpotifyToken | null = null;

function fingerprintConfig(config: SpotifyAuthConfig): string {
  return [config.clientId, config.clientSecret, config.refreshToken, config.market].join(":");
}

function parseSpotifyErrorMessage(bodyText: string): string {
  try {
    const payload = JSON.parse(bodyText) as { error?: { message?: string; status?: number; }; };
    const message = payload.error?.message?.trim() || "";
    const status = payload.error?.status;
    return status != null
      ? `${status}${message ? `: ${message}` : ""}`
      : message || bodyText.trim() || "Unknown Spotify error";
  } catch {
    return bodyText.trim() || "Unknown Spotify error";
  }
}

async function refreshSpotifyAccessToken(config: SpotifyAuthConfig): Promise<{ accessToken: string; tokenType: string; }> {
  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken
    })
  });

  const bodyText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(`Spotify token refresh failed (${tokenResponse.status}): ${parseSpotifyErrorMessage(bodyText)}`);
  }

  const payload = JSON.parse(bodyText) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!payload.access_token || !payload.token_type || !payload.expires_in) {
    throw new Error(`Spotify token refresh returned an unexpected payload: ${bodyText.slice(0, 500)}`);
  }

  cachedSpotifyToken = {
    configFingerprint: fingerprintConfig(config),
    accessToken: payload.access_token,
    tokenType: payload.token_type,
    expiresAt: Date.now() + Math.max(0, payload.expires_in - 60) * 1000
  };

  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type
  };
}

async function getSpotifyAccessToken(config: SpotifyAuthConfig): Promise<{ accessToken: string; tokenType: string; }> {
  const fingerprint = fingerprintConfig(config);
  if (cachedSpotifyToken?.configFingerprint === fingerprint && cachedSpotifyToken.expiresAt > Date.now()) {
    return {
      accessToken: cachedSpotifyToken.accessToken,
      tokenType: cachedSpotifyToken.tokenType
    };
  }

  return refreshSpotifyAccessToken(config);
}

export function parseSpotifySearchResponse(bodyText: string, status: number): SpotifySearchTrack[] {
  let payload: {
    error?: { message?: string; status?: number; };
    tracks?: { items?: Array<{ id?: string; name?: string; external_urls?: { spotify?: string; }; artists?: Array<{ name?: string; }>; }>; };
  };

  try {
    payload = JSON.parse(bodyText) as typeof payload;
  } catch {
    console.error(`[poke-discord-bridge] Spotify search returned non-JSON response: status=${status} body=${bodyText.slice(0, 500)}`);
    throw new Error(`Spotify search returned a non-JSON response (${status}). Refresh the Spotify auth token and restart, then try again.`);
  }

  if (payload.error) {
    const message = payload.error.message?.trim() || "Unknown Spotify error";
    const errorStatus = payload.error.status ?? status;
    throw new Error(`Spotify search failed (${errorStatus}): ${message}`);
  }

  const items = payload.tracks?.items;
  if (!Array.isArray(items)) {
    console.error(`[poke-discord-bridge] Spotify search response missing tracks.items: status=${status} keys=${Object.keys(payload).join(",")} body=${bodyText.slice(0, 500)}`);
    throw new Error("Spotify search returned an unexpected response. Refresh the Spotify auth token and restart, then try again.");
  }

  return items
    .filter((track): track is NonNullable<typeof track> => Boolean(track?.name && track?.external_urls?.spotify))
    .map(track => ({
      id: track.id,
      name: track.name ?? "",
      url: track.external_urls?.spotify ?? "",
      artists: (track.artists ?? []).map(artist => ({ name: artist.name ?? "" }))
    }))
    .filter(track => track.name.length > 0 && track.url.length > 0);
}

export async function searchSpotifyTracks(
  query: string,
  config: SpotifyAuthConfig,
  limit = 10
): Promise<SpotifySearchTrack[]> {
  const { accessToken, tokenType } = await getSpotifyAccessToken(config);

  const searchUrl = new URL("https://api.spotify.com/v1/search");
  searchUrl.searchParams.set("type", "track");
  searchUrl.searchParams.set("q", query.trim());
  searchUrl.searchParams.set("limit", String(limit));
  searchUrl.searchParams.set("market", config.market);

  const response = await fetch(searchUrl, {
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
      "User-Agent": "PokeDiscord"
    }
  });

  const bodyText = await response.text();
  return parseSpotifySearchResponse(bodyText, response.status);
}
