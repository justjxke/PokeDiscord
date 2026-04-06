import { describe, expect, test } from "bun:test";

import { encryptTenantSecret } from "../src/tenantSecrets";
import { buildDiscordRelayPrompt, buildGroupPrompt } from "../src/prompt";
import {
  createDefaultState,
  getTenantPokeSecret,
  isGroupChannelInstalled,
  normalizeState,
  removeGroupInstallation,
  setGroupKey
} from "../src/bridgePolicy";
import type { DiscordRelayRequest } from "../src/types";

describe("group chat bridge state", () => {
  test("stores, decrypts, and removes shared group installs", () => {
    const encrypted = encryptTenantSecret("poke-api-key", "state-secret", 1234);
    const initial = createDefaultState();
    const installed = setGroupKey(initial, "group-channel-1", "installer-1", encrypted);

    expect(isGroupChannelInstalled(installed, "group-channel-1")).toBe(true);
    expect(getTenantPokeSecret(installed, { kind: "group", id: "group-channel-1" }, "state-secret")).toBe("poke-api-key");

    const removed = removeGroupInstallation(installed, "group-channel-1");
    expect(isGroupChannelInstalled(removed, "group-channel-1")).toBe(false);
    expect(getTenantPokeSecret(removed, { kind: "group", id: "group-channel-1" }, "state-secret")).toBeNull();
  });

  test("normalizes persisted group installs", () => {
    const encrypted = encryptTenantSecret("persisted-key", "state-secret", 4321);
    const normalized = normalizeState(
      {
        groupInstallations: {
          "group-channel-2": {
            installedByUserId: "installer-2",
            installedAt: 1111,
            updatedAt: 2222,
            linkedAt: 3333,
            encryptedPokeApiKey: encrypted
          }
        }
      },
      "state-secret"
    );

    expect(normalized.groupInstallations["group-channel-2"]).toMatchObject({
      installedByUserId: "installer-2",
      installedAt: 1111,
      updatedAt: 2222,
      linkedAt: 3333
    });
    expect(getTenantPokeSecret(normalized, { kind: "group", id: "group-channel-2" }, "state-secret")).toBe("persisted-key");
  });
});

describe("group chat prompt", () => {
  const request: DiscordRelayRequest = {
    bridgeRequestId: "bridge-1",
    tenant: {
      kind: "group",
      id: "group-channel-1"
    },
    discordUserId: "user-1",
    discordChannelId: "group-channel-1",
    discordMessageId: "message-1",
    mode: "group",
    prompt: "how are you today?",
    replyTarget: {
      channelId: "group-channel-1",
      label: "Group chat",
      mode: "group",
      createdAt: 1
    },
    attachments: [],
    contextMessages: [],
    voiceContext: null
  };

  test("uses the group preface without guild voice instructions", () => {
    const prompt = buildDiscordRelayPrompt(request);

    expect(prompt).toContain("shared group chat");
    expect(prompt).toContain("shared chat-scoped");
    expect(prompt).toContain("keep installation or operator details private");
    expect(prompt).not.toContain("voice playback");
  });

  test("exports a standalone group prompt preface", () => {
    expect(buildGroupPrompt()).toContain("shared group chat");
  });
});
