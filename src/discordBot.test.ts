import { expect, test } from "bun:test";
import type { Client } from "discord.js";

import { evaluateGuildProactiveReply } from "./discordBot";
import {
  consumeGuildProactiveConversationTurn,
  createDefaultState,
  getGuildProactiveConversationState,
  isGuildProactiveRepliesAllowed,
  setGuildProactiveChannelOverride,
  setGuildProactiveReplyMode,
  startGuildProactiveConversation
} from "./bridgePolicy";
import { getDiscordChannelHistory } from "./discordBot";
import type { BridgeState, GuildInstallationState } from "./types";

function makeGuildInstallation(overrides: Partial<GuildInstallationState> = {}): GuildInstallationState {
  return {
    installedByUserId: "user-1",
    installedAt: Date.now(),
    updatedAt: Date.now(),
    linkedAt: Date.now(),
    allowedChannelIds: ["channel-123"],
    encryptedPokeApiKey: null,
    proactiveRepliesEnabled: true,
    proactiveChannelOverrides: {},
    proactiveConversationState: {},
    ...overrides
  };
}

test("getDiscordChannelHistory paginates before a cursor and returns pagination metadata", async () => {
  const seenFetches: Array<Record<string, unknown>> = [];

  const messages = new Map([
    ["m5", { id: "m5", content: "five", author: { username: "eve" }, createdTimestamp: 5000, reference: null, attachments: new Map() }],
    ["m4", { id: "m4", content: "four", author: { username: "dan" }, createdTimestamp: 4000, reference: null, attachments: new Map() }],
    ["m3", { id: "m3", content: "three", author: { username: "cora" }, createdTimestamp: 3000, reference: null, attachments: new Map() }],
    ["m2", { id: "m2", content: "two", author: { username: "bob" }, createdTimestamp: 2000, reference: null, attachments: new Map() }],
    ["m1", { id: "m1", content: "one", author: { username: "alice" }, createdTimestamp: 1000, reference: null, attachments: new Map() }]
  ]);

  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async (options: Record<string, unknown>) => {
        seenFetches.push(options);
        const limit = Number(options.limit ?? 50);
        const before = typeof options.before === "string" ? options.before : undefined;
        const after = typeof options.after === "string" ? options.after : undefined;

        let selected = Array.from(messages.values());
        if (before) {
          selected = selected.filter(message => message.id < before);
        }
        if (after) {
          selected = selected.filter(message => message.id > after);
        }

        return new Map(selected.slice(0, limit).map(message => [message.id, message]));
      }
    }
  };

  const client = {
    channels: {
      fetch: async (channelId: string) => {
        expect(channelId).toBe("channel-123");
        return channel;
      }
    }
  } as unknown as Client;

  const page = await getDiscordChannelHistory(client, "channel-123", {
    limit: 2,
    beforeMessageId: "m5"
  });

  expect(seenFetches).toEqual([{ limit: 2, before: "m5" }]);
  expect(page.messages.map(message => message.id)).toEqual(["m3", "m4"]);
  expect(page.nextBeforeMessageId).toBe("m3");
  expect(page.nextAfterMessageId).toBe("m4");
  expect(page.hasMoreBefore).toBe(true);
  expect(page.hasMoreAfter).toBe(true);
});

test("evaluateGuildProactiveReply accepts direct mentions and proactive callouts", () => {
  const direct = evaluateGuildProactiveReply({
    content: "@Poke can you help with this?",
    mentioned: true,
    repliedToBot: false,
    proactiveAllowed: false,
    activeConversation: null
  });

  expect(direct.shouldRelay).toBe(true);
  expect(direct.startConversation).toBe(true);
  expect(direct.reason).toBe("direct");

  const proactive = evaluateGuildProactiveReply({
    content: "Poke, what do you think about this?",
    mentioned: false,
    repliedToBot: false,
    proactiveAllowed: true,
    activeConversation: null
  });

  expect(proactive.shouldRelay).toBe(true);
  expect(proactive.startConversation).toBe(true);
  expect(proactive.reason).toBe("proactive");
  expect(proactive.promptContent).toBe("what do you think about this?");
});

test("evaluateGuildProactiveReply only follows up inside an active short thread", () => {
  const followup = evaluateGuildProactiveReply({
    content: "and can you explain why?",
    mentioned: false,
    repliedToBot: false,
    proactiveAllowed: false,
    activeConversation: {
      activeUntil: Date.now() + 60_000,
      turnsLeft: 1
    }
  });

  expect(followup.shouldRelay).toBe(true);
  expect(followup.reason).toBe("followup");

  const silent = evaluateGuildProactiveReply({
    content: "random chatter that is not for Poke",
    mentioned: false,
    repliedToBot: false,
    proactiveAllowed: true,
    activeConversation: null
  });

  expect(silent.shouldRelay).toBe(false);
});

test("guild proactive settings support server and channel overrides with short threads", () => {
  const state: BridgeState = createDefaultState();
  state.guildInstallations["guild-1"] = makeGuildInstallation({
    proactiveRepliesEnabled: false,
    proactiveChannelOverrides: { "channel-123": true }
  });

  expect(isGuildProactiveRepliesAllowed(state, "guild-1", "channel-123")).toBe(true);
  expect(isGuildProactiveRepliesAllowed(state, "guild-1", "channel-999")).toBe(false);

  Object.assign(state, setGuildProactiveReplyMode(state, "guild-1", true));
  expect(isGuildProactiveRepliesAllowed(state, "guild-1", "channel-999")).toBe(true);

  Object.assign(state, setGuildProactiveChannelOverride(state, "guild-1", "channel-999", false));
  expect(isGuildProactiveRepliesAllowed(state, "guild-1", "channel-999")).toBe(false);

  Object.assign(state, startGuildProactiveConversation(state, "guild-1", "channel-123", 2, 60_000));
  const conversation = getGuildProactiveConversationState(state, "guild-1", "channel-123");
  expect(conversation?.turnsLeft).toBe(2);
  expect(conversation?.activeUntil).toBeGreaterThan(Date.now());

  Object.assign(state, consumeGuildProactiveConversationTurn(state, "guild-1", "channel-123", 60_000));
  expect(getGuildProactiveConversationState(state, "guild-1", "channel-123")?.turnsLeft).toBe(1);

  Object.assign(state, consumeGuildProactiveConversationTurn(state, "guild-1", "channel-123", 60_000));
  expect(getGuildProactiveConversationState(state, "guild-1", "channel-123")).toBeNull();
});
