import type { DiscordRelayRequest, DiscordSentMessageRecord } from "./types";

interface RuntimeTargetStore {
  getRequest(bridgeRequestId: string): DiscordRelayRequest | undefined;
  getSentMessages(bridgeRequestId: string): ({ bridgeRequestId?: string } & DiscordSentMessageRecord) | undefined;
}

export function resolveRequestContext(
  store: RuntimeTargetStore,
  bridgeRequestId: string
): DiscordRelayRequest {
  const request = store.getRequest(bridgeRequestId);
  if (!request) {
    throw new Error("Discord request context not found.");
  }

  return request;
}

export function resolveReplyChannelId(
  store: RuntimeTargetStore,
  meta?: { channelId?: string; bridgeRequestId?: string }
): string {
  if (meta?.channelId) {
    return meta.channelId;
  }

  if (meta?.bridgeRequestId) {
    return resolveRequestContext(store, meta.bridgeRequestId).replyTarget.channelId;
  }

  throw new Error("Discord reply target not found.");
}

export function resolveSentMessageTarget(
  store: RuntimeTargetStore,
  meta?: { channelId?: string; bridgeRequestId?: string; messageId?: string }
): { channelId: string; messageId: string } {
  if (meta?.channelId && meta?.messageId) {
    return {
      channelId: meta.channelId,
      messageId: meta.messageId
    };
  }

  if (meta?.bridgeRequestId) {
    const record = store.getSentMessages(meta.bridgeRequestId);
    if (!record) {
      throw new Error("Discord message target not found.");
    }

    if (meta.messageId) {
      if (!record.messageIds.includes(meta.messageId)) {
        throw new Error("Discord message target is not owned by this bridge request.");
      }
      return {
        channelId: record.channelId,
        messageId: meta.messageId
      };
    }

    if (record.messageIds.length !== 1) {
      throw new Error("Multiple Discord messages were sent for that request; provide messageId.");
    }

    return {
      channelId: record.channelId,
      messageId: record.messageIds[0] as string
    };
  }

  throw new Error("Discord message target not found.");
}
