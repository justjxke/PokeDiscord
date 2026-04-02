import assert from "node:assert/strict";
import test from "node:test";

import { buildDmPrompt, buildGuildPrompt } from "../src/prompt";

test("guild prompt includes a conversational safety preface", () => {
  const prompt = buildGuildPrompt();

  assert.match(prompt, /public server/i);
  assert.match(prompt, /personal/i);
  assert.match(prompt, /avoid/i);
});

test("dm prompt keeps private use open", () => {
  const prompt = buildDmPrompt();

  assert.match(prompt, /direct message/i);
  assert.match(prompt, /private/i);
});
