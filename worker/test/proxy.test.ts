import assert from "node:assert/strict";
import test from "node:test";

import { proxyRequest } from "../src/proxy";

test("proxy forwards POST /messages/ to the backend", async () => {
  let forwardedUrl = "";
  let forwardedMethod = "";
  let forwardedBody = "";
  let forwardedSecret = "";

  const response = await proxyRequest(
    new Request("https://poke-discord-bridge.pokediscord.workers.dev/messages/?session_id=test", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    }),
    {
      POKE_BACKEND_ORIGIN: "https://backend.example.com",
      POKE_EDGE_SECRET: "secret"
    },
    async (url, init) => {
      forwardedUrl = typeof url === "string" ? url : url.toString();
      forwardedMethod = init?.method ?? "";
      forwardedBody = typeof init?.body === "string" ? init.body : "";
      forwardedSecret = init?.headers instanceof Headers ? init.headers.get("x-poke-edge-secret") ?? "" : "";
      return new Response("ok", { status: 200 });
    }
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, "https://backend.example.com/messages/?session_id=test");
  assert.equal(forwardedMethod, "POST");
  assert.equal(forwardedBody, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.equal(forwardedSecret, "secret");
});

test("proxy preserves backend path prefixes", async () => {
  let forwardedUrl = "";

  const response = await proxyRequest(
    new Request("https://poke-discord-bridge.pokediscord.workers.dev/messages/?session_id=test", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    }),
    {
      POKE_BACKEND_ORIGIN: "https://backend.example.com/daemon",
      POKE_EDGE_SECRET: "secret"
    },
    async (url) => {
      forwardedUrl = typeof url === "string" ? url : url.toString();
      return new Response("ok", { status: 200 });
    }
  );

  assert.equal(response.status, 200);
  assert.equal(forwardedUrl, "https://backend.example.com/daemon/messages/?session_id=test");
});

test("proxy returns the endpoint event stream for GET /mcp", async () => {
  const response = await proxyRequest(
    new Request("https://poke-discord-bridge.pokediscord.workers.dev/mcp", {
      method: "GET"
    }),
    {
      POKE_BACKEND_ORIGIN: "https://backend.example.com",
      POKE_EDGE_SECRET: "secret"
    },
    async () => new Response("should-not-be-called")
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("mcp-session-id")?.length, 36);
});
