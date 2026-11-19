import assert from "node:assert/strict";
import { test } from "node:test";

import { validateProviderSettings } from "./settings.mjs";

const settings = (block) => ({ theme: "dark", "pi-cliproxyapi-provider": block });

test("no settings, or no provider block, overrides nothing", () => {
  assert.deepEqual(validateProviderSettings({}), {});
  assert.deepEqual(validateProviderSettings({ theme: "dark" }), {});
  assert.deepEqual(validateProviderSettings(undefined), {});
  assert.deepEqual(validateProviderSettings([]), {});
});

test("a valid block reports its messageThreads value", () => {
  assert.deepEqual(validateProviderSettings(settings({ messageThreads: true })), { messageThreads: true });
  assert.deepEqual(validateProviderSettings(settings({ messageThreads: false })), { messageThreads: false });
  assert.deepEqual(validateProviderSettings(settings({ gpt56ContextWindow: "full", perTurnEffort: false })), {});
});

test("a block the extension would reject is an error", () => {
  assert.match(validateProviderSettings(settings(true)).error, /must be an object/);
  assert.match(validateProviderSettings(settings({ messageThreads: "yes" })).error, /messageThreads must be a boolean/);
  assert.match(validateProviderSettings(settings({ gpt56ContextWindow: "huge" })).error, /gpt56ContextWindow/);
  assert.match(validateProviderSettings(settings({ showStrictMode: 1 })).error, /showStrictMode must be a boolean/);
});
