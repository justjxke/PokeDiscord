# Discord Typing, Edit, and Delete Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a bridge-side Discord typing indicator while Poke is working, plus tools to edit and delete messages that the bridge has already sent.

**Architecture:** Keep the current worker + local backend split. The backend will own Discord message lifecycle tracking so it can map Poke tool calls to Discord message ids. Typing will be implemented as a local loop that calls Discord's typing API while a Poke request is in flight, then stops as soon as the response returns.

**Tech Stack:** TypeScript, discord.js, existing MCP HTTP transport, existing Cloudflare Worker proxy.

---

### Task 1: Add bridge-side typing indicator support

**Files:**
- Modify: `src/index.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/types.ts`
- Test: `pnpm typecheck`

**Step 1: Define the behavior**
- Start typing in the target Discord channel as soon as the bridge hands a request to Poke.
- Continue refreshing typing until the Poke response returns or fails.
- Stop typing immediately when the request finishes.

**Step 2: Implement minimal typing loop**
- Add a small helper that calls Discord's typing API on an interval.
- Make it safe to stop on success, failure, or shutdown.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 2: Track sent Discord message ids for later edits/deletes

**Files:**
- Modify: `src/types.ts`
- Modify: `src/index.ts`
- Modify: `src/discordBot.ts`
- Test: `pnpm typecheck`

**Step 1: Add message tracking shape**
- Store enough metadata to find the most recent Discord message created for a given bridge request.
- Keep the mapping in backend memory first; only persist if needed.

**Step 2: Capture ids on send**
- Update message sending so the created Discord message id is available to later tool calls.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 3: Add edit and delete MCP tools

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/prompt.ts`
- Modify: `src/index.ts`
- Modify: `src/discordBot.ts`
- Test: `pnpm typecheck`

**Step 1: Add tool schemas**
- Add `editDiscordMessage`.
- Add `deleteDiscordMessage`.

**Step 2: Wire the handlers**
- `editDiscordMessage` should update a previously sent Discord message.
- `deleteDiscordMessage` should delete a previously sent Discord message.

**Step 3: Teach the prompt**
- Tell Poke when to use edit vs delete.
- Keep the guidance short and explicit.

**Step 4: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 4: Verify the behavior manually

**Files:**
- None

**Step 1: Test typing**
- Send `@Poke ...` or `/poke` in Discord.
- Confirm the channel shows typing while Poke is processing.

**Step 2: Test edit**
- Ask Poke to send a message and then edit it.
- Confirm the same Discord message updates.

**Step 3: Test delete**
- Ask Poke to delete one of its own messages.
- Confirm the message disappears.

**Step 4: Confirm regressions are absent**
- Re-test DM flow, `@Poke`, `/poke`, reply, and reaction behavior.
- Expected: all previous behavior still works.
