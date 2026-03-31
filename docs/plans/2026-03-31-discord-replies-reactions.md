# Discord Replies and Reactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Poke reply to specific Discord messages and add reactions from the bridge.

**Architecture:** Keep the current MCP bridge shape, but add explicit tools for replying and reacting. Reuse the Discord client and message lookup logic in the Node backend so Poke can choose between plain sends, message replies, and emoji reactions without changing the Cloudflare Worker proxy layer.

**Tech Stack:** TypeScript, discord.js, existing MCP HTTP transport, existing Node backend.

---

### Task 1: Extend the MCP tool surface

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/types.ts`
- Test: `pnpm typecheck`

**Step 1: Update the request metadata passed to Discord sending**
- Add reply-target message ids and reaction fields to the tool payloads.

**Step 2: Add explicit tools**
- Add `replyToDiscordMessage` for replying to a specific Discord message.
- Add `reactToDiscordMessage` for adding a reaction to a specific message.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 2: Implement Discord reply and reaction handling

**Files:**
- Modify: `src/discordBot.ts`
- Modify: `src/index.ts`
- Modify: `src/prompt.ts`

**Step 1: Write minimal handlers**
- Reply by sending a Discord message with a message reference.
- React by fetching the target message and calling `message.react(emoji)`.

**Step 2: Update the prompt**
- Tell Poke when to use the reply and reaction tools.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 3: Verify behavior

**Files:**
- None

**Step 1: Exercise the new tool flows manually**
- Test `@Poke` in a server.
- Test replying to a specific message.
- Test reaction adding.

**Step 2: Confirm no regressions**
- Run the bridge and confirm existing `/poke` and DM behavior still works.
- Expected: PASS
