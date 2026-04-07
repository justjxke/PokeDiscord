import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";

import { startDeferredTypingIndicator } from "../src/discordBot";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("startDeferredTypingIndicator", () => {
  test("does not start typing when the request finishes before the delay", async () => {
    let startCount = 0;
    const client = {} as Client;

    const stopTyping = await startDeferredTypingIndicator(client, "channel-1", 50, async () => {
      startCount += 1;
      return async () => {
        startCount += 100;
      };
    });

    await stopTyping();
    await sleep(75);

    expect(startCount).toBe(0);
  });

  test("starts typing only after the delay and stops it when finished", async () => {
    let startCount = 0;
    let stopCount = 0;
    const client = {} as Client;

    const stopTyping = await startDeferredTypingIndicator(client, "channel-1", 25, async () => {
      startCount += 1;
      return async () => {
        stopCount += 1;
      };
    });

    await sleep(50);
    expect(startCount).toBe(1);
    expect(stopCount).toBe(0);

    await stopTyping();
    expect(stopCount).toBe(1);
  });
});
