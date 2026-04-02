# Guild Tone and Safety Prompt Layering Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Keep Poke’s natural voice in guilds while preventing identity and personal-data leaks by layering a tenant-specific conversational preface onto the shared prompt.

**Architecture:** Use one shared base prompt for Poke’s existing voice, then inject a small per-tenant preface at request time. Guilds get a conversational safety preface that discourages personal or identity-style answers without sounding like a moderation system. DMs get a lighter private-use preface that keeps the owner/private flow usable. The bridge remains permissive; it shapes context instead of hard-refusing messages.

**Tech Stack:** TypeScript, discord.js bridge, existing Poke MCP request pipeline, existing tenant/state model.

---

### Task 1: Add prompt builders for guild and DM contexts

**Objective:** Create small helper functions that return the shared base prompt plus a tenant-specific preface.

**Files:**
- Modify: `src/prompt.ts`
- Modify: `src/types.ts`
- Test: `test/prompt.test.ts`

**Step 1: Write failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildGuildPrompt, buildDmPrompt } from "../src/prompt";

test("guild prompt includes a natural safety preface", () => {
  const prompt = buildGuildPrompt();
  assert.match(prompt, /public server/i);
  assert.match(prompt, /avoid/i);
  assert.match(prompt, /personal/i);
});

test("dm prompt keeps the private flow open", () => {
  const prompt = buildDmPrompt();
  assert.match(prompt, /direct message/i);
  assert.match(prompt, /private/i);
});
```

**Step 2: Run the test to verify failure**

Run: `pnpm test -- test/prompt.test.ts`
Expected: FAIL — the helpers do not exist yet.

**Step 3: Implement the minimal prompt helpers**

```ts
const BASE_PROMPT = `...existing Poke prompt...`;

const GUILD_PREFACE = `You're in a public server. Keep the tone natural and helpful, but avoid personal identity details, account linkage details, or other private facts. If a question drifts that way, steer gently back to safe, useful help.`;

const DM_PREFACE = `This is a direct message. Keep the same natural tone, and support the user's private setup and personal use without exposing anything about other people.`;

export function buildGuildPrompt(): string {
  return `${GUILD_PREFACE}\n\n${BASE_PROMPT}`;
}

export function buildDmPrompt(): string {
  return `${DM_PREFACE}\n\n${BASE_PROMPT}`;
}
```

**Step 4: Run the test to verify pass**

Run: `pnpm test -- test/prompt.test.ts`
Expected: PASS

### Task 2: Select the right prompt at request time

**Objective:** Route guild requests through the guild prompt and DM requests through the DM prompt.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/discordBot.ts`
- Modify: `src/bridgePolicy.ts`

**Step 1: Add prompt selection to the outgoing request path**
- Pass tenant kind into the Poke request build step.
- Choose the prompt builder based on whether the message came from a guild or a DM.

**Step 2: Keep the bridge permissive**
- Do not block guild messages in the bridge.
- Only change the prompt context that gets sent to Poke.

**Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

### Task 3: Make tenant context explicit in the bridge request model

**Objective:** Ensure the request payload clearly distinguishes guild and DM contexts so prompt selection cannot drift.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state.ts`
- Modify: `src/index.ts`

**Step 1: Add explicit tenant fields**
- Confirm the relay request includes tenant kind and any relevant guild/user ids needed to choose the prompt.

**Step 2: Keep storage unchanged**
- Do not expand stored state beyond what is needed for prompt selection and tenant routing.

**Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

### Task 4: Verify guild and DM behavior manually

**Objective:** Confirm the bot stays natural in both contexts and does not leak personal details in guilds.

**Files:**
- None

**Step 1: Test guild safety**
- Ask in a server who owns the bot or what it knows about Jake.
- Expected: Poke answers in its normal style without revealing personal identity or linkage details.

**Step 2: Test DM behavior**
- Ask the same style of question in a DM while using the private/owner path.
- Expected: the private flow still feels like Poke and remains usable.

**Step 3: Confirm no regressions**
- Existing setup, state, and bridge behavior should remain intact.
- Expected: PASS
