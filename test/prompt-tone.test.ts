import assert from "node:assert/strict";
import test from "node:test";

import { buildGuildPrompt } from "../src/prompt";

test("guild prompt encourages playful refusals without rule narration", () => {
  const prompt = buildGuildPrompt().toLowerCase();

  assert.match(prompt, /dunno|not sure|can't help with that/);
  assert.doesNotMatch(prompt, /checking rules|rules rq|policy|guidelines/);
});
