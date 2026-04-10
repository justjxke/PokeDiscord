import { describe, expect, test } from "bun:test";

import { requireBridgeRequestId, resolvePublicMessageTargetInputs } from "../src/mcp";
import { resolveReplyChannelId, resolveSentMessageTarget } from "../src/runtimeTargets";

describe("public Discord tool target resolution", () => {
  test("accepts explicit channel ids without a bridge request id", () => {
    expect(resolvePublicMessageTargetInputs({ channelId: "  channel-1  " })).toEqual({
      channelId: "channel-1",
      bridgeRequestId: undefined
    });
  });

  test("requires a channel id or bridge request id for public message tools", () => {
    expect(() => resolvePublicMessageTargetInputs({})).toThrow("channelId or bridgeRequestId is required.");
  });

  test("still requires a bridge request id for voice tools", () => {
    expect(() => requireBridgeRequestId({})).toThrow("bridgeRequestId is required.");
    expect(requireBridgeRequestId({ bridgeRequestId: "  request-1  " })).toBe("request-1");
  });
});

describe("runtime target precedence", () => {
  const failingStore = {
    getRequest(): never {
      throw new Error("bridge request should not be consulted");
    },
    getSentMessages(): never {
      throw new Error("bridge request should not be consulted");
    }
  } as any;

  test("prefers an explicit reply channel over a stale bridge request", () => {
    expect(resolveReplyChannelId(failingStore, {
      channelId: "channel-1",
      bridgeRequestId: "stale-request"
    })).toBe("channel-1");
  });

  test("prefers explicit message targets over a stale bridge request", () => {
    expect(resolveSentMessageTarget(failingStore, {
      channelId: "channel-1",
      messageId: "message-1",
      bridgeRequestId: "stale-request"
    })).toEqual({
      channelId: "channel-1",
      messageId: "message-1"
    });
  });

  test("falls back to the stored request context when explicit ids are absent", () => {
    const store = {
      getRequest(bridgeRequestId: string) {
        if (bridgeRequestId !== "request-1") {
          return undefined;
        }

        return {
          bridgeRequestId,
          replyTarget: { channelId: "channel-from-request" }
        };
      },
      getSentMessages(bridgeRequestId: string) {
        if (bridgeRequestId !== "request-1") {
          return undefined;
        }

        return {
          bridgeRequestId,
          channelId: "channel-from-request",
          messageIds: ["message-from-request"]
        };
      }
    } as any;

    expect(resolveReplyChannelId(store, {
      bridgeRequestId: "request-1"
    })).toBe("channel-from-request");

    expect(resolveSentMessageTarget(store, {
      bridgeRequestId: "request-1"
    })).toEqual({
      channelId: "channel-from-request",
      messageId: "message-from-request"
    });
  });
});
