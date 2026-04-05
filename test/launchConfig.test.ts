import { describe, expect, test } from "bun:test";

import { buildLavalinkConfig } from "../src/launchConfig";

describe("buildLavalinkConfig", () => {
  test("disables legacy youtube source under lavalink.server.sources", () => {
    const config = buildLavalinkConfig("super-secret");

    expect(config).toContain("lavalink:");
    expect(config).toContain("  server:");
    expect(config).toContain("    sources:");
    expect(config).toContain("      youtube: false");
  });

  test("includes poToken configuration when provided", () => {
    const config = buildLavalinkConfig("super-secret", {
      youtubePoToken: "po-token",
      youtubeVisitorData: "visitor-data"
    });

    expect(config).toContain("    pot:");
    expect(config).toContain('      token: "po-token"');
    expect(config).toContain('      visitorData: "visitor-data"');
    expect(config).toContain("      - WEB");
    expect(config).toContain("      - WEBEMBEDDED");
    expect(config).not.toContain("      - TV");
    expect(config).not.toContain("      - ANDROID_VR");
    expect(config).toContain("      WEB:");
    expect(config).toContain("        playback: true");
  });

  test("includes oauth configuration when provided", () => {
    const config = buildLavalinkConfig("super-secret", {
      youtubeOauthEnabled: true,
      youtubeOauthRefreshToken: "refresh-token",
      youtubeOauthSkipInitialization: true
    });

    expect(config).toContain("    oauth:");
    expect(config).toContain("      enabled: true");
    expect(config).toContain('      refreshToken: "refresh-token"');
    expect(config).toContain("      skipInitialization: true");
    expect(config).toContain("      - WEB");
    expect(config).toContain("      - WEBEMBEDDED");
    expect(config).toContain("      - TV");
    expect(config).toContain("      WEB:");
    expect(config).toContain("        playback: false");
    expect(config).toContain("        searching: true");
    expect(config).toContain("      WEBEMBEDDED:");
    expect(config).toContain("        playback: false");
  });

  test("supports oauth enrollment mode without a refresh token", () => {
    const config = buildLavalinkConfig("super-secret", {
      youtubeOauthEnabled: true,
      youtubeOauthSkipInitialization: false
    });

    expect(config).toContain("    oauth:");
    expect(config).toContain("      enabled: true");
    expect(config).toContain("      skipInitialization: false");
    expect(config).not.toContain("refreshToken:");
  });

  test("includes remote cipher configuration when provided", () => {
    const config = buildLavalinkConfig("super-secret", {
      youtubeOauthEnabled: true,
      youtubeOauthRefreshToken: "refresh-token",
      youtubeOauthSkipInitialization: true,
      youtubeRemoteCipherUrl: "https://cipher.kikkia.dev/",
      youtubeRemoteCipherPassword: "cipher-password",
      youtubeRemoteCipherUserAgent: "poke-discord-bridge"
    });

    expect(config).toContain("    remoteCipher:");
    expect(config).toContain('      url: "https://cipher.kikkia.dev/"');
    expect(config).toContain('      password: "cipher-password"');
    expect(config).toContain('      userAgent: "poke-discord-bridge"');
  });
});
