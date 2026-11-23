import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decideFusionOutcome,
  formatModelLabel,
  normalizeGatewayModel,
  parseGithubOutput,
  parseModels,
  parseModelSlots,
  reorderDiffFiles,
  slotLabel,
  stripProviderPrefix,
} from "./fusion-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("parseModels normalizes, deduplicates, and rejects invalid gateway models", () => {
  assert.deepEqual(parseModels("gpt-6.2-sol, cpa/claude-opus-5-5\ncpa/gpt-6.2-sol"), [
    "cpa/gpt-6.2-sol",
    "cpa/claude-opus-5-5",
  ]);
  assert.deepEqual(parseModels("", "judge-fallback-models", { required: false }), []);
  assert.throws(() => parseModels("  ", "models"), /at least one gateway model/);
  assert.throws(() => parseModels("openai/gpt-6.2-sol", "models"), /gateway models/);
  assert.throws(() => parseModels("cpa/claude-opus-5-5[1m]", "models"), /bracketed context selector/);
  assert.throws(() => normalizeGatewayModel("cpa/", "judge-model"), /no model id/);
});

test("slotLabel maps indexes to A..Z and numbers beyond", () => {
  assert.equal(slotLabel(0), "A");
  assert.equal(slotLabel(1), "B");
  assert.equal(slotLabel(25), "Z");
  assert.equal(slotLabel(26), "27");
});

test("reorderDiffFiles preserves canonical order for seed 0 and reorders multi-file diffs deterministically", () => {
  const diff = [
    "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-1\n+2\n",
    "diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-3\n+4\n",
    "diff --git a/c.js b/c.js\n--- a/c.js\n+++ b/c.js\n@@ -1 +1 @@\n-5\n+6\n",
  ].join("");

  assert.equal(reorderDiffFiles(diff, 0), diff);
  const reversed = reorderDiffFiles(diff, 1);
  assert.ok(reversed.startsWith("diff --git a/c.js"));
  assert.ok(reversed.endsWith("+2\n"));
  assert.equal(reversed.length, diff.length);

  // Deterministic for seed >= 2 and preserves exact content set.
  const shuffledA = reorderDiffFiles(diff, 2);
  const shuffledB = reorderDiffFiles(diff, 2);
  assert.equal(shuffledA, shuffledB);
  assert.equal(shuffledA.length, diff.length);

  // Single-file or non-git patch stays untouched.
  const single = "diff --git a/a.js b/a.js\n+1\n";
  assert.equal(reorderDiffFiles(single, 1), single);
  assert.equal(reorderDiffFiles("--- a.js\n+++ a.js\n+1\n", 1), "--- a.js\n+++ a.js\n+1\n");
});

test("parseGithubOutput handles both key=value and multiline heredoc entries", () => {
  const raw = [
    "turns=4",
    "result<<ghadelimiter_123",
    "VERDICT: request-changes",
    "",
    "**Findings**",
    "1. `a.js:1`: bug",
    "ghadelimiter_123",
    "rate-limited=false",
  ].join("\n");
  assert.deepEqual(parseGithubOutput(raw), {
    turns: "4",
    result: "VERDICT: request-changes\n\n**Findings**\n1. `a.js:1`: bug",
    "rate-limited": "false",
  });
});

test("parseModelSlots parses per-slot fallback chains and rejects empty or invalid entries", () => {
  assert.deepEqual(
    parseModelSlots("cpa/claude-opus-5-5 | cpa/gpt-6.2-sol\ncpa/gpt-6.2-sol | cpa/claude-opus-5-5 | cpa/gpt-6.2-sol"),
    [
      { model: "cpa/claude-opus-5-5", fallbacks: ["cpa/gpt-6.2-sol"] },
      { model: "cpa/gpt-6.2-sol", fallbacks: ["cpa/claude-opus-5-5"] },
    ],
  );
  assert.deepEqual(parseModelSlots("gpt-6.2-sol, claude-opus-5-5"), [
    { model: "cpa/gpt-6.2-sol", fallbacks: [] },
    { model: "cpa/claude-opus-5-5", fallbacks: [] },
  ]);
  assert.throws(() => parseModelSlots("cpa/claude-opus-5-5 | "), /empty fallback/);
  assert.throws(() => parseModelSlots("  "), /at least one gateway model/);
  assert.throws(() => parseModelSlots("cpa/claude-opus-5-5 | openai/gpt-6.2-sol"), /gateway models/);
});

test("formatModelLabel joins distinct models, collapses repeated fallback models, and appends a distinct judge", () => {
  assert.equal(stripProviderPrefix("cpa/gpt-6.2-sol"), "gpt-6.2-sol");
  assert.equal(formatModelLabel(["cpa/claude-opus-5-5", "cpa/gpt-6.2-sol"], "cpa/claude-opus-5-5"), "claude-opus-5-5 + gpt-6.2-sol");
  assert.equal(formatModelLabel(["cpa/claude-opus-5-5", "cpa/claude-opus-5-5"], "cpa/claude-opus-5-5"), "claude-opus-5-5 ×2");
  assert.equal(
    formatModelLabel(["cpa/claude-opus-5-5", "cpa/claude-opus-5-5"], "cpa/gpt-6.2-sol"),
    "claude-opus-5-5 ×2 -> gpt-6.2-sol",
  );
  assert.equal(
    formatModelLabel(["cpa/gpt-6.2-sol", "cpa/claude-opus-5-5"], "cpa/gemini-3-pro"),
    "gpt-6.2-sol + claude-opus-5-5 -> gemini-3-pro",
  );
  assert.equal(formatModelLabel(["cpa/gpt-6.2-sol"], "cpa/claude-opus-5-5"), "gpt-6.2-sol");
});

test("decideFusionOutcome short-circuits cleanly on unanimous approvals, single survivor, and all-rate-limited", () => {
  const cleanA = { slot: "A", requestedModel: "cpa/gpt-6.2-sol", status: "ok", verdict: "approve", report: "" };
  const cleanB = { slot: "B", requestedModel: "cpa/claude-opus-5-5", status: "ok", verdict: "approve", report: "  " };
  const notedB = { slot: "B", requestedModel: "cpa/claude-opus-5-5", status: "ok", verdict: "approve", report: "**Notes**\n- nit" };
  const blockB = { slot: "B", requestedModel: "cpa/claude-opus-5-5", status: "ok", verdict: "request-changes", report: "1. bug" };
  const rlA = { slot: "A", requestedModel: "cpa/gpt-6.2-sol", status: "rate-limited", error: "quota" };
  const rlB = { slot: "B", requestedModel: "cpa/claude-opus-5-5", status: "rate-limited", error: "quota" };
  const failB = { slot: "B", requestedModel: "cpa/claude-opus-5-5", status: "failed", error: "boom" };

  assert.equal(decideFusionOutcome([cleanA, cleanB]).action, "short-circuit-approve");
  assert.equal(decideFusionOutcome([cleanA, notedB]).action, "synthesize");
  assert.equal(decideFusionOutcome([cleanA, blockB]).action, "synthesize");
  assert.equal(decideFusionOutcome([cleanA, rlB]).action, "passthrough");
  assert.equal(decideFusionOutcome([cleanA, failB]).action, "passthrough");
  assert.equal(decideFusionOutcome([rlA, rlB]).action, "rate-limited");
  assert.equal(decideFusionOutcome([rlA, failB]).action, "fail");
});

test("fusion.mjs --validate accepts valid model config and rejects invalid models", () => {
  const script = path.join(__dirname, "fusion.mjs");
  const ok = spawnSync(process.execPath, [script, "--validate"], {
    env: {
      ...process.env,
      PI_FUSION_MODELS: "cpa/gpt-6.2-sol\ncpa/claude-opus-5-5",
      PI_FUSION_JUDGE_MODEL: "cpa/claude-opus-5-5",
      PI_FUSION_JUDGE_FALLBACK_MODELS: "cpa/gpt-6.2-sol",
    },
    encoding: "utf8",
  });
  assert.equal(ok.status, 0);

  const bad = spawnSync(process.execPath, [script, "--validate"], {
    env: {
      ...process.env,
      PI_FUSION_MODELS: "openai/gpt-6.2-sol",
      PI_FUSION_JUDGE_MODEL: "cpa/claude-opus-5-5",
    },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /::error title=pi-pr-review-fusion::/);
});
