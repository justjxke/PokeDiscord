import { describe, expect, test } from "bun:test";

import { parseSpotifySearchResponse } from "../src/spotifySearch";

describe("parseSpotifySearchResponse", () => {
  test("parses track search results", () => {
    const results = parseSpotifySearchResponse(
      JSON.stringify({
        tracks: {
          items: [
            {
              id: "1",
              name: "Uptown Funk",
              external_urls: { spotify: "https://open.spotify.com/track/1" },
              artists: [{ name: "Mark Ronson" }, { name: "Bruno Mars" }]
            }
          ]
        }
      }),
      200
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "1",
      name: "Uptown Funk",
      url: "https://open.spotify.com/track/1"
    });
  });

  test("throws on malformed search responses", () => {
    expect(() => parseSpotifySearchResponse(JSON.stringify({ foo: "bar" }), 200)).toThrow(
      "Spotify search returned an unexpected response"
    );
  });

  test("throws on api error payloads", () => {
    expect(() => parseSpotifySearchResponse(JSON.stringify({ error: { status: 403, message: "Forbidden" } }), 403)).toThrow(
      "Spotify search failed (403): Forbidden"
    );
  });
});
