#!/usr/bin/env node
/**
 * Parallel multi-model PR review orchestrator + skeptical verifier synthesizer.
 *
 * Spawns one isolated `runner.mjs` process per configured reviewer model (separate
 * HOME, RUNNER_TEMP, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, and reordered diff.patch
 * for slots >= 1 so reviewers never collide on cache/transcripts or anchor on the
 * same first file). Short-circuits when all surviving reviewers approve cleanly or
 * only one reviewer survives; otherwise runs an anonymized skeptical verifier judge
 * pass and emits standard `result`, `model-used`, `rate-limited` outputs for
 * `pr-review/apply.mjs`.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env, fail, setOutput, summary, warn } from "../lib/common.mjs";
import { buildBody, parseResult, planReview } from "../pr-review/review.mjs";
import {
  decideFusionOutcome,
  formatModelLabel,
  normalizeGatewayModel,
  parseGithubOutput,
  parseModels,
  reorderDiffFiles,
  slotLabel,
  stripProviderPrefix,
} from "./fusion-lib.mjs";

const TITLE = "pi-pr-review-fusion";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(__dirname, "..", "runner.mjs");

let models;
let judgeModel;
let judgeFallbacks;
try {
  models = parseModels(process.env.PI_FUSION_MODELS, "models", { required: true });
  judgeModel = normalizeGatewayModel(env("PI_FUSION_JUDGE_MODEL") || models[0], "judge-model");
  judgeFallbacks = parseModels(process.env.PI_FUSION_JUDGE_FALLBACK_MODELS, "judge-fallback-models", {
    required: false,
  });
} catch (error) {
  fail(TITLE, error.message);
}

if (process.argv.includes("--validate")) {
  process.exit(0);
}

const repo = env("PI_FUSION_REPO");
const prNumber = env("PI_FUSION_PR");
const mode = env("PI_FUSION_MODE", "verdict");
const contextDir = env("PI_FUSION_CONTEXT_DIR");
const workDir = env("PI_FUSION_WORK_DIR");
const reviewerSkill = env("PI_ACTION_SKILL");
const judgeSkill = env("PI_FUSION_JUDGE_SKILL");
const reviewerThinking = env("PI_ACTION_THINKING", "medium");
const judgeThinking = env("PI_FUSION_JUDGE_THINKING", "medium");
const reviewerMaxTurns = env("PI_ACTION_MAX_TURNS", "40");
const judgeMaxTurns = env("PI_FUSION_JUDGE_MAX_TURNS", "25");
const onRateLimit = env("PI_ACTION_ON_RATE_LIMIT", "skip").toLowerCase();

if (!repo || !prNumber || !contextDir || !workDir) {
  fail(TITLE, "PI_FUSION_REPO, PI_FUSION_PR, PI_FUSION_CONTEXT_DIR and PI_FUSION_WORK_DIR are required.");
}

// Kept outside workDir and populated only after the judge exits so model-named transcript
// filenames never sit beside the anonymized candidates directory during synthesis.
const transcriptsDir = path.join(path.dirname(workDir), "pi-pr-review-fusion-transcripts");
rmSync(transcriptsDir, { recursive: true, force: true });
mkdirSync(transcriptsDir, { recursive: true, mode: 0o700 });
setOutput("transcripts-dir", transcriptsDir);

const pendingTranscripts = [];
let transcriptsFlushed = false;
function flushTranscripts() {
  if (transcriptsFlushed) return;
  transcriptsFlushed = true;
  for (const { src, destName } of pendingTranscripts) {
    if (existsSync(src)) copyFileSync(src, path.join(transcriptsDir, `${destName}.jsonl`));
  }
}
process.on("exit", flushTranscripts);

/** Build a per-slot context copy with reordered diff.patch when seed > 0. */
function prepareSlotContext(slotDir, seed) {
  if (seed <= 0) return contextDir;
  const diffPath = path.join(contextDir, "diff.patch");
  const diffText = existsSync(diffPath) ? readFileSync(diffPath, "utf8") : "";
  const reordered = reorderDiffFiles(diffText, seed);
  if (reordered === diffText) return contextDir;
  const slotIn = path.join(slotDir, "in");
  mkdirSync(slotIn, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(contextDir)) {
    if (name === "diff.patch") continue;
    copyFileSync(path.join(contextDir, name), path.join(slotIn, name));
  }
  writeFileSync(path.join(slotIn, "diff.patch"), reordered, "utf8");
  return slotIn;
}

/** Spawn one isolated runner.mjs child process and capture its outputs and transcript. */
function runSlot({ name, transcriptName, envOverrides }) {
  const slotDir = path.join(workDir, "runs", name);
  const slotHome = path.join(slotDir, "home");
  const slotTemp = path.join(slotDir, "tmp");
  const outputFile = path.join(slotDir, "github-output.txt");
  const summaryFile = path.join(slotDir, "step-summary.md");
  mkdirSync(slotHome, { recursive: true, mode: 0o700 });
  mkdirSync(slotTemp, { recursive: true, mode: 0o700 });
  writeFileSync(outputFile, "", { mode: 0o600 });
  writeFileSync(summaryFile, "", { mode: 0o600 });

  const childEnv = {
    ...process.env,
    ...envOverrides,
    HOME: slotHome,
    RUNNER_TEMP: slotTemp,
    TMPDIR: slotTemp,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    // Always skip inside individual slots so we can distinguish quota from hard failures.
    PI_ACTION_ON_RATE_LIMIT: "skip",
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER_PATH], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const outputs = existsSync(outputFile) ? parseGithubOutput(readFileSync(outputFile, "utf8")) : {};
      if (outputs.transcript && existsSync(outputs.transcript)) {
        pendingTranscripts.push({ src: outputs.transcript, destName: transcriptName });
      }
      resolve({ code: code ?? 1, stdout, stderr, outputs });
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, outputs: {} });
    });
  });
}

const guardedSecrets = [env("PI_ACTION_CPA_API_KEY"), env("PI_ACTION_GH_TOKEN")].filter((value) => value.length >= 8);
const redact = (text) => guardedSecrets.reduce((out, secret) => out.replaceAll(secret, "[REDACTED]"), String(text ?? ""));

function extractFailureDetail(runResult) {
  const lines = redact(`${runResult.stdout}\n${runResult.stderr}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.find((line) => line.startsWith("::error "));
  if (errorLine) return errorLine.replace(/^::error[^:]*::/, "").slice(0, 300);
  return (lines.slice(-2).join(" ") || `exit ${runResult.code}`).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Phase 1: Parallel independent reviews
// ---------------------------------------------------------------------------

process.stdout.write(`pi-pr-review-fusion: starting ${models.length} parallel reviewer(s): ${models.join(", ")}\n`);

const reviewerPromises = models.map(async (model, index) => {
  const label = slotLabel(index);
  const slug = `reviewer-${label.toLowerCase()}`;
  const slotDir = path.join(workDir, "runs", slug);
  mkdirSync(slotDir, { recursive: true, mode: 0o700 });
  const slotContextDir = prepareSlotContext(slotDir, index);
  const prompt =
    `Review pull request #${prNumber} in ${repo} following the pr-review skill, and end with your ` +
    `verdict message. The prefetched context directory is ${slotContextDir}. Review mode: ${mode}.`;

  const res = await runSlot({
    name: slug,
    transcriptName: `${slug}-${stripProviderPrefix(model).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    envOverrides: {
      PI_ACTION_PROMPT: prompt,
      PI_ACTION_PROMPT_FILE: "",
      PI_ACTION_SKILL: reviewerSkill,
      PI_ACTION_MODEL: model,
      PI_ACTION_FALLBACK_MODELS: "",
      PI_ACTION_THINKING: reviewerThinking,
      PI_ACTION_MAX_TURNS: reviewerMaxTurns,
    },
  });

  if (res.outputs["rate-limited"] === "true") {
    return {
      slot: label,
      requestedModel: model,
      status: "rate-limited",
      modelUsed: res.outputs["model-used"] || model,
      turns: res.outputs.turns || "0",
      result: "",
      verdict: "",
      report: "",
      error: "quota exhausted",
    };
  }
  if (res.code !== 0) {
    return {
      slot: label,
      requestedModel: model,
      status: "failed",
      modelUsed: res.outputs["model-used"] || model,
      turns: res.outputs.turns || "0",
      result: "",
      verdict: "",
      report: "",
      error: extractFailureDetail(res),
    };
  }

  try {
    const parsed = parseResult(res.outputs.result);
    const plan = planReview(parsed, mode);
    // Validate that request-changes actually carries a non-empty body.
    buildBody({ verdict: plan.verdict, report: parsed.report, model: res.outputs["model-used"] || model });
    return {
      slot: label,
      requestedModel: model,
      status: "ok",
      modelUsed: res.outputs["model-used"] || model,
      turns: res.outputs.turns || "0",
      result: res.outputs.result,
      verdict: parsed.verdict,
      report: parsed.report,
      error: "",
    };
  } catch (error) {
    return {
      slot: label,
      requestedModel: model,
      status: "failed",
      modelUsed: res.outputs["model-used"] || model,
      turns: res.outputs.turns || "0",
      result: "",
      verdict: "",
      report: "",
      error: `unusable verdict: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
});

const reviewerRuns = await Promise.all(reviewerPromises);

for (const run of reviewerRuns) {
  if (run.status === "rate-limited") {
    warn(TITLE, `Reviewer ${run.slot} (${run.requestedModel}) hit gateway quota cooldown and was skipped.`);
  } else if (run.status === "failed") {
    warn(TITLE, `Reviewer ${run.slot} (${run.requestedModel}) failed: ${run.error}`);
  } else {
    const noteFlag = run.verdict === "approve" && run.report ? " (with notes)" : "";
    process.stdout.write(
      `pi-pr-review-fusion: Reviewer ${run.slot} (${run.modelUsed}) -> ${run.verdict}${noteFlag} in ${run.turns} turn(s).\n`,
    );
  }
}

const decision = decideFusionOutcome(reviewerRuns);

function writeFusionSummary(judgeInfo) {
  summary("### Pi fusion review\n");
  summary("| Slot | Model | Outcome | Turns |");
  summary("|---|---|---|---|");
  for (const run of reviewerRuns) {
    const outcome =
      run.status === "ok"
        ? run.verdict === "approve" && run.report
          ? "approve (with notes)"
          : run.verdict
        : `${run.status}${run.error ? ` (${run.error.slice(0, 120)})` : ""}`;
    summary(`| Reviewer ${run.slot} | \`${stripProviderPrefix(run.modelUsed)}\` | ${outcome} | ${run.turns} |`);
  }
  if (judgeInfo) {
    summary(`| Synthesizer | \`${stripProviderPrefix(judgeInfo.model)}\` | ${judgeInfo.outcome} | ${judgeInfo.turns} |`);
  }
  summary("");
}

// ---------------------------------------------------------------------------
// Phase 2: Short-circuit or synthesize
// ---------------------------------------------------------------------------

if (decision.action === "rate-limited") {
  writeFusionSummary(null);
  setOutput("rate-limited", "true");
  setOutput("model-used", models.map(stripProviderPrefix).join(" + "));
  setOutput("models-used", "");
  if (onRateLimit === "skip") {
    warn(TITLE, "Every reviewer model hit gateway quota cooldown; skipping review.");
    process.exit(0);
  }
  fail(TITLE, "Every reviewer model hit gateway quota cooldown.");
}

if (decision.action === "fail") {
  writeFusionSummary(null);
  setOutput("rate-limited", "false");
  fail(TITLE, `All reviewers failed: ${decision.reason}`);
}

if (decision.action === "passthrough") {
  const winner = decision.run;
  writeFusionSummary({ model: "skipped", outcome: "single surviving reviewer", turns: "0" });
  setOutput("result", winner.result);
  setOutput("model-used", stripProviderPrefix(winner.modelUsed));
  setOutput("models-used", stripProviderPrefix(winner.modelUsed));
  setOutput("rate-limited", "false");
  process.exit(0);
}

if (decision.action === "short-circuit-approve") {
  const label = formatModelLabel(decision.runs.map((r) => r.modelUsed));
  writeFusionSummary({ model: "skipped", outcome: "unanimous clean approval", turns: "0" });
  setOutput("result", "VERDICT: approve");
  setOutput("model-used", label);
  setOutput("models-used", decision.runs.map((r) => stripProviderPrefix(r.modelUsed)).join(","));
  setOutput("rate-limited", "false");
  process.exit(0);
}

// Synthesize 2+ surviving reviewers via anonymized skeptical verifier pass.
const surviving = decision.runs;
const candidatesDir = path.join(workDir, "candidates");
mkdirSync(candidatesDir, { recursive: true, mode: 0o700 });
const candidateFiles = [];
for (const run of surviving) {
  const filename = `reviewer-${run.slot.toLowerCase()}.md`;
  candidateFiles.push(filename);
  writeFileSync(
    path.join(candidatesDir, filename),
    `# Reviewer ${run.slot}\n\n${run.result.trim()}\n`,
    "utf8",
  );
}

const judgePrompt =
  `Synthesize and verify the independent pull request reviews for #${prNumber} in ${repo} following the ` +
  `pr-review-fusion skill, and end with your final verdict message. The prefetched PR context directory ` +
  `is ${contextDir}. The anonymized candidate reviews directory is ${candidatesDir} ` +
  `(${candidateFiles.join(", ")}). Review mode: ${mode}.`;

process.stdout.write(`pi-pr-review-fusion: running skeptical verifier (${judgeModel}) across ${surviving.length} candidate review(s)...\n`);

const judgeRes = await runSlot({
  name: "judge",
  transcriptName: "judge",
  envOverrides: {
    PI_ACTION_PROMPT: judgePrompt,
    PI_ACTION_PROMPT_FILE: "",
    PI_ACTION_SKILL: judgeSkill,
    PI_ACTION_MODEL: judgeModel,
    PI_ACTION_FALLBACK_MODELS: judgeFallbacks.join("\n"),
    PI_ACTION_THINKING: judgeThinking,
    PI_ACTION_MAX_TURNS: judgeMaxTurns,
  },
});

if (judgeRes.outputs["rate-limited"] === "true") {
  // Never silently drop a blocking review if the judge is rate-limited.
  const fallbackRun = surviving.find((r) => r.verdict === "request-changes") ?? surviving[0];
  warn(
    TITLE,
    `Synthesizer (${judgeModel}) hit gateway quota cooldown; falling back to Reviewer ${fallbackRun.slot} (${fallbackRun.modelUsed}).`,
  );
  writeFusionSummary({
    model: judgeRes.outputs["model-used"] || judgeModel,
    outcome: `rate-limited (fell back to Reviewer ${fallbackRun.slot})`,
    turns: judgeRes.outputs.turns || "0",
  });
  setOutput("result", fallbackRun.result);
  setOutput("model-used", stripProviderPrefix(fallbackRun.modelUsed));
  setOutput("models-used", stripProviderPrefix(fallbackRun.modelUsed));
  setOutput("rate-limited", "false");
  process.exit(0);
}

if (judgeRes.code !== 0) {
  const detail = extractFailureDetail(judgeRes);
  writeFusionSummary({
    model: judgeRes.outputs["model-used"] || judgeModel,
    outcome: `failed (${detail.slice(0, 120)})`,
    turns: judgeRes.outputs.turns || "0",
  });
  fail(TITLE, `Synthesizer failed: ${detail}`);
}

let judgeParsed;
try {
  judgeParsed = parseResult(judgeRes.outputs.result);
  const judgePlan = planReview(judgeParsed, mode);
  buildBody({ verdict: judgePlan.verdict, report: judgeParsed.report, model: judgeRes.outputs["model-used"] || judgeModel });
} catch (error) {
  writeFusionSummary({
    model: judgeRes.outputs["model-used"] || judgeModel,
    outcome: `unusable verdict`,
    turns: judgeRes.outputs.turns || "0",
  });
  fail(TITLE, `Synthesizer did not produce a usable verdict: ${error instanceof Error ? error.message : String(error)}`);
}

const actualJudgeModel = judgeRes.outputs["model-used"] || judgeModel;
const modelLabel = formatModelLabel(
  surviving.map((r) => r.modelUsed),
  actualJudgeModel,
);
writeFusionSummary({
  model: actualJudgeModel,
  outcome: judgeParsed.verdict === "approve" && judgeParsed.report ? "approve (with notes)" : judgeParsed.verdict,
  turns: judgeRes.outputs.turns || "0",
});
setOutput("result", judgeRes.outputs.result);
setOutput("model-used", modelLabel);
setOutput("models-used", surviving.map((r) => stripProviderPrefix(r.modelUsed)).join(","));
setOutput("rate-limited", "false");
flushTranscripts();
