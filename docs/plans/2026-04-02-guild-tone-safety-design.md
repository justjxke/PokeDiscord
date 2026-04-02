# Guild Tone and Safety Prompt Layering Design

> **For Claude:** keep the implementation aligned with Poke’s existing voice. Use a shared base prompt plus small tenant-specific prefaces. Do not rely on a bridge-side hard block for guild behavior.

**Goal:** Prevent Poke from leaking personal or identity-style details in guilds while preserving Poke’s natural tone and keeping DMs usable for private-owner interactions.

**Architecture:** Keep one canonical Poke base prompt, then inject a short preface at request time based on tenant type. Guild requests get a conversational safety preface that nudges the model away from personal identity, account linkage, age, or private facts. DM requests get a lighter preface that preserves the private-use flow. The bridge should not refuse guild requests outright; it should shape the request context before forwarding it to Poke.

**Tech Stack:** TypeScript, existing Discord bridge, existing Poke request pipeline, existing tenant/state model.

---

### Task 1: Define prompt layering rules

**Files:**
- Modify: `src/prompt.ts`
- Modify: `src/types.ts`
- Test: `pnpm typecheck`

**Step 1: Keep one shared base prompt**
- Preserve the current Poke voice, style, and general behavior in a single base prompt.

**Step 2: Add tenant-specific prefices**
- Add a guild preface that sounds natural and conversational.
- Add a DM/private preface that keeps the private-owner flow open.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 2: Select the right prompt at request time

**Files:**
- Modify: `src/index.ts`
- Modify: `src/bridgePolicy.ts`
- Modify: `src/discordBot.ts`

**Step 1: Route by tenant kind**
- For guild messages, prepend the guild preface before forwarding to Poke.
- For direct messages, prepend the DM/private preface.

**Step 2: Keep the bridge permissive**
- Do not hard-block guild requests.
- Let Poke handle the final response, but with the safer context injected by the bridge.

**Step 3: Run typecheck**
- Run: `pnpm typecheck`
- Expected: PASS

### Task 3: Verify behavior manually

**Files:**
- None

**Step 1: Test guild safety**
- Ask the bot in a server who owns it, what it knows about Jake, or who is linked via API key.
- Expected: the model should respond naturally without leaking personal details.

**Step 2: Test DM/private flow**
- Ask the bot the same style of question in DMs when using the private-owner path.
- Expected: the private path still behaves like a personal assistant and preserves the expected tone.

**Step 3: Confirm no regressions**
- Existing setup, typing, reply, and state behavior should remain intact.
- Expected: PASS
