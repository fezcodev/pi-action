import assert from "node:assert/strict";
import { test } from "node:test";

import { projectMessageThreads, providerStartupFailure, supportsMessageThreads } from "./settings.mjs";

test("messageThreads needs provider 0.6.0 or later", () => {
  assert.equal(supportsMessageThreads("0.6.0"), true);
  assert.equal(supportsMessageThreads("0.7.2"), true);
  assert.equal(supportsMessageThreads("1.0.0"), true);
  assert.equal(supportsMessageThreads("0.5.1"), false);
  assert.equal(supportsMessageThreads("0.4.0"), false);
  assert.equal(supportsMessageThreads(undefined), false);
  assert.equal(supportsMessageThreads("next"), false);
});

test("projectMessageThreads reports only a boolean", () => {
  const block = (value) => ({ theme: "dark", "pi-cliproxyapi-provider": { messageThreads: value } });
  assert.equal(projectMessageThreads(block(true)), true);
  assert.equal(projectMessageThreads(block(false)), false);
  assert.equal(projectMessageThreads(block("yes")), undefined);
  assert.equal(projectMessageThreads({ "pi-cliproxyapi-provider": true }), undefined);
  assert.equal(projectMessageThreads({}), undefined);
  assert.equal(projectMessageThreads(undefined), undefined);
});

test("providerStartupFailure extracts the provider's reason", () => {
  const line =
    "[pi-cliproxyapi-provider] registered placeholder provider after startup failure: " +
    "pi-cliproxyapi-provider.messageThreads must be a boolean in project settings.json";
  assert.equal(
    providerStartupFailure(line),
    "pi-cliproxyapi-provider.messageThreads must be a boolean in project settings.json",
  );
  assert.equal(providerStartupFailure("Warning: Model \"x\" not found for provider \"cpa\"."), undefined);
});
