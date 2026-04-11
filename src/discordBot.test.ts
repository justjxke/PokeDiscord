import { expect, test } from "bun:test";
import type { Client } from "discord.js";

import { getDiscordChannelHistory } from "./discordBot";

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
