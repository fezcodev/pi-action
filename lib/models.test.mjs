import assert from "node:assert/strict";
import { test } from "node:test";

import { inferOwner, parseModelSpecs, planModelChain, withModelSpecs } from "./models.mjs";

const listing = [
  { id: "claude-opus-5-5", object: "model", owned_by: "anthropic", created: 1 },
  { id: "gpt-6-sol", object: "model", owned_by: "openai", created: 2 },
];

test("a fully listed chain adds nothing", () => {
  const { unlisted, snapshot } = planModelChain(["gpt-6-sol", "claude-opus-5-5"], listing);
  assert.deepEqual(unlisted, []);
  assert.deepEqual(snapshot, listing);
});

test("an unlisted primary is kept and gets a synthetic snapshot entry", () => {
  const { unlisted, snapshot } = planModelChain(["gpt-6.2-sol", "claude-opus-5-5"], listing);
  assert.deepEqual(unlisted, ["gpt-6.2-sol"]);
  assert.deepEqual(snapshot, [...listing, { id: "gpt-6.2-sol", object: "model", owned_by: "openai" }]);
});

test("an id with no known family gets no owner", () => {
  const { snapshot } = planModelChain(["mystery-1"], listing);
  assert.deepEqual(snapshot.at(-1), { id: "mystery-1", object: "model" });
});

test("duplicates in the chain yield one entry", () => {
  const { unlisted, snapshot } = planModelChain(["gpt-6.2-sol", "gpt-6.2-sol"], listing);
  assert.deepEqual(unlisted, ["gpt-6.2-sol"]);
  assert.equal(snapshot.length, listing.length + 1);
});

test("parseModelSpecs reads CPA's Codex-client catalog into the extension's spec shape", () => {
  const specs = parseModelSpecs({
    models: [
      {
        slug: "gpt-6.2-sol",
        display_name: "GPT 6.2 Sol",
        context_window: 500000,
        max_context_window: 872000,
        max_tokens: 128000,
        supported_reasoning_levels: [{ effort: "Low" }, { effort: "high" }, { nope: 1 }],
        input_modalities: ["text", "image"],
      },
      // Template filler: no max_tokens, so not CPA's own data.
      { slug: "gpt-image-3", context_window: 272000 },
      { display_name: "no slug", max_tokens: 1 },
    ],
  });
  assert.deepEqual([...specs.keys()], ["gpt-6.2-sol"]);
  assert.deepEqual(specs.get("gpt-6.2-sol"), {
    displayName: "GPT 6.2 Sol",
    contextWindow: 500000,
    maxContextWindow: 872000,
    maxTokens: 128000,
    reasoningLevels: ["low", "high"],
    inputModalities: ["text", "image"],
  });
});

test("parseModelSpecs treats a plain /models list as no specs", () => {
  assert.equal(parseModelSpecs({ object: "list", data: listing }).size, 0);
  assert.equal(parseModelSpecs(null).size, 0);
});

test("withModelSpecs attaches specs by id and leaves the rest alone", () => {
  const specs = new Map([["gpt-6-sol", { maxTokens: 128000 }]]);
  assert.deepEqual(withModelSpecs(listing, specs), [listing[0], { ...listing[1], spec: { maxTokens: 128000 } }]);
});

test("inferOwner maps CLIProxyAPI families", () => {
  assert.equal(inferOwner("claude-sonnet-5-5"), "anthropic");
  assert.equal(inferOwner("gpt-6.2-sol"), "openai");
  assert.equal(inferOwner("o4-mini"), "openai");
  assert.equal(inferOwner("gemini-3-pro"), "google");
  assert.equal(inferOwner("kimi-k3"), undefined);
});
