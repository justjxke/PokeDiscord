import { expect, test } from "bun:test";

import { startMcpServer } from "./mcp";

async function postJson(url: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify(body)
  });
}

test("accepts a stale MCP session for explicit-channel outbound sends", async () => {
  const calls: Array<{ channelId: string; content: string }> = [];
  const { server, port } = await startMcpServer({
    host: "127.0.0.1",
    port: 0,
    sessionTtlMs: 1,
    allowPublicHealth: true,
    getHealthStatus: () => ({ ok: true }),
    onSendDiscordMessage: async (content, meta) => {
      calls.push({ channelId: meta?.channelId ?? "", content });
      return ["msg-1"];
    },
    onEditDiscordMessage: async () => undefined,
    onDeleteDiscordMessage: async () => undefined,
    onReactDiscordMessage: async () => undefined,
    onGetChannelHistory: async () => [],
    onQueueVoiceTrack: async () => ({ ok: true, action: "queue", message: "ok", session: null }),
    onControlVoicePlayback: async () => ({ ok: true, action: "control", message: "ok", session: null })
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const initializeResponse = await postJson(`${baseUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    });
    expect(initializeResponse.status).toBe(200);

    const sessionId = initializeResponse.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();

    await new Promise(resolve => setTimeout(resolve, 10));

    const toolResponse = await postJson(`${baseUrl}/messages/`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "sendDiscordMessage",
        arguments: {
          channelId: "dm-channel-123",
          content: "reminder fired"
        }
      }
    }, sessionId ?? undefined);

    expect(toolResponse.status).toBe(200);
    const payload = await toolResponse.json() as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
    };

    expect(payload.result?.isError).toBe(false);
    expect(payload.result?.content?.[0]?.text).toContain('"sent":true');
    expect(calls).toEqual([{ channelId: "dm-channel-123", content: "reminder fired" }]);
  } finally {
    server.close();
  }
});

test("lists and serves channel history as a public tool", async () => {
  const history = [
    {
      id: "msg-1",
      content: "hello from history",
      author: "alice",
      timestamp: "2026-04-11T00:00:00.000Z",
      isReply: false,
      attachments: []
    }
  ];

  const { server, port } = await startMcpServer({
    host: "127.0.0.1",
    port: 0,
    sessionTtlMs: 60_000,
    allowPublicHealth: true,
    getHealthStatus: () => ({ ok: true }),
    onSendDiscordMessage: async () => [],
    onEditDiscordMessage: async () => undefined,
    onDeleteDiscordMessage: async () => undefined,
    onReactDiscordMessage: async () => undefined,
    onGetChannelHistory: async meta => {
      expect(meta).toEqual({ channelId: "channel-123", limit: 25 });
      return history;
    },
    onQueueVoiceTrack: async () => ({ ok: true, action: "queue", message: "ok", session: null }),
    onControlVoicePlayback: async () => ({ ok: true, action: "control", message: "ok", session: null })
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const initializeResponse = await postJson(`${baseUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    });
    expect(initializeResponse.status).toBe(200);

    const sessionId = initializeResponse.headers.get("Mcp-Session-Id");
    expect(sessionId).toBeTruthy();

    const listResponse = await postJson(`${baseUrl}/mcp`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }, sessionId ?? undefined);

    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json() as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(listPayload.result?.tools?.some(tool => tool.name === "getChannelHistory")).toBe(true);

    const toolResponse = await postJson(`${baseUrl}/messages/`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "getChannelHistory",
        arguments: {
          channelId: "channel-123",
          limit: 25
        }
      }
    }, sessionId ?? undefined);

    expect(toolResponse.status).toBe(200);
    const payload = await toolResponse.json() as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
      };
    };

    expect(payload.result?.isError).toBe(false);
    expect(payload.result?.content?.[0]?.text).toContain('"author":"alice"');
    expect(payload.result?.content?.[0]?.text).toContain('"content":"hello from history"');
  } finally {
    server.close();
  }
});
