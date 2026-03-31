# Discord Attachments and Embeds Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Poke send Discord messages with file attachments and richer embeds/structured formatting.

**Architecture:** Extend the existing Discord MCP send/reply surface so messages can carry optional attachment and embed payloads. Keep the Cloudflare Worker unchanged; all message rendering happens in the local Node backend that already owns Discord delivery.

**Tech Stack:** TypeScript, discord.js, existing MCP HTTP transport, existing Cloudflare Worker proxy.

---

### Task 1: Add attachment and embed shapes to the bridge types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/pokeClient.ts`
- Modify: `src/prompt.ts`
- Test: `pnpm typecheck`

**Step 1: Define payload shapes**
- Add a small attachment descriptor for Discord messages.
- Add a simple embed descriptor with the fields we actually want to support first.

**Step 2: Thread them through the Poke request payload**
- Make sure the Poke API receives the new fields so future prompt/tool logic can use them.

**Step 3: Update the prompt**
- Tell Poke when to use attachments vs embeds.

**Step 4: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 2: Teach the MCP tools to accept attachments and embeds

**Files:**
- Modify: `src/mcp.ts`
- Test: `pnpm typecheck`

**Step 1: Extend tool schemas**
- Add optional `attachments` to send/reply tools.
- Add optional `embeds` to send/reply/edit tools.

**Step 2: Validate minimally**
- Keep schemas strict enough to avoid garbage input.
- Accept simple URLs and embed metadata only.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 3: Render attachments and embeds in Discord

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/index.ts`
- Test: `pnpm typecheck`

**Step 1: Convert attachment descriptors into Discord files**
- Fetch remote URLs.
- Send them as Discord files alongside the message.

**Step 2: Convert embed descriptors into Discord embeds**
- Map the supported fields into `EmbedBuilder`.
- Keep the first version intentionally small and predictable.

**Step 3: Wire through send/reply/edit paths**
- Ensure sends can include files and embeds.
- Ensure replies can also include them.
- Allow edits to update content and embeds.

**Step 4: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 4: Verify behavior manually

**Files:**
- None

**Step 1: Test a simple embed**
- Ask Poke to send a Discord embed-style summary.

**Step 2: Test an attachment**
- Ask Poke to send a message with a file/image attachment URL.

**Step 3: Confirm existing behavior still works**
- Re-test plain send, reply, edit, delete, reaction, and typing.
- Expected: no regressions.
