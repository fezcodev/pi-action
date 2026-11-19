import assert from "node:assert/strict";
import { test } from "node:test";

import { readProjectProviderSettings } from "./settings.mjs";

const settings = (block) => JSON.stringify({ theme: "dark", "pi-cliproxyapi-provider": block });

test("no provider block, or unparseable JSON, overrides nothing", () => {
  assert.deepEqual(readProjectProviderSettings(JSON.stringify({ theme: "dark" })), {});
  assert.deepEqual(readProjectProviderSettings("{ not json"), {});
  assert.deepEqual(readProjectProviderSettings("[]"), {});
});

test("a valid block reports its messageThreads value", () => {
  assert.deepEqual(readProjectProviderSettings(settings({ messageThreads: true })), { messageThreads: true });
  assert.deepEqual(readProjectProviderSettings(`\uFEFF${settings({ messageThreads: false })}`), { messageThreads: false });
  assert.deepEqual(readProjectProviderSettings(settings({ gpt56ContextWindow: "full", perTurnEffort: false })), {});
});

test("a block the extension would reject is an error", () => {
  assert.match(readProjectProviderSettings(settings(true)).error, /must be an object/);
  assert.match(readProjectProviderSettings(settings({ messageThreads: "yes" })).error, /messageThreads must be a boolean/);
  assert.match(readProjectProviderSettings(settings({ gpt56ContextWindow: "huge" })).error, /gpt56ContextWindow/);
  assert.match(readProjectProviderSettings(settings({ showStrictMode: 1 })).error, /showStrictMode must be a boolean/);
});
