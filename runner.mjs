#!/usr/bin/env node
/**
 * pi-action runner.
 *
 * Drives `pi -p --mode json` against a CLIProxyAPI gateway through the
 * @hank-warren/pi-cliproxyapi-provider extension, enforces a turn cap and a
 * wall-clock timeout, captures the full JSONL transcript, and reports outputs
 * back to GitHub Actions. Zero npm dependencies on purpose: everything here is
 * Node builtins plus the GITHUB_OUTPUT / GITHUB_STEP_SUMMARY file protocols.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { inferOwner, parseModelSpecs, planModelChain, withModelSpecs } from "./lib/models.mjs";
import { projectMessageThreads, providerStartupFailure, supportsMessageThreads } from "./lib/settings.mjs";

// The extension registers models under this provider name: `cpa/<model-id>`.
const PROVIDER_NAME = "cpa";

/**
 * Quota exhaustion.
 *
 * When every gateway credential for a model is cooling down, CLIProxyAPI
 * answers 429 `model_cooldown` ("All credentials for model X are cooling
 * down"). Upstream subscription wording can also pass through. Pi treats 429s as
 * retryable, so this surfaces as a failed run after retries, or as the
 * retry-delay ceiling being exceeded on a large `retry-after`. Both land on an
 * assistant message with `stopReason: "error"` and an `errorMessage` we match.
 *
 * Being out of quota is not the same failure as a broken action, and callers
 * need to tell them apart.
 */
const QUOTA_EXHAUSTED_PATTERN = new RegExp(
  [
    "model_cooldown",
    "are cooling down",
    "session limit",
    "weekly limit",
    "usage limit",
    "rate limit reached",
    "Server requested \\d+s retry delay",
  ].join("|"),
  "i",
);

function input(name) {
  return (process.env[name] ?? "").trim();
}

function fail(message) {
  process.stdout.write(`::error title=pi-action::${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stdout.write(`::warning title=pi-action::${message}\n`);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}

// ---------------------------------------------------------------------------
// Resolve the prompt
// ---------------------------------------------------------------------------

const promptInline = input("PI_ACTION_PROMPT");
const promptFile = input("PI_ACTION_PROMPT_FILE");

if (promptInline && promptFile) {
  fail("Provide either `prompt` or `prompt-file`, not both.");
}

let prompt = promptInline;
if (promptFile) {
  if (!existsSync(promptFile)) fail(`prompt-file not found: ${promptFile}`);
  prompt = readFileSync(promptFile, "utf8").trim();
}
if (!prompt) {
  fail("No prompt supplied. Set `prompt` or `prompt-file`.");
}

// ---------------------------------------------------------------------------
// Resolve the gateway
//
// All model traffic goes through CLIProxyAPI via the pi-cliproxyapi-provider
// extension, which reads its connection settings from these env vars (they
// override any config file). Ambient Anthropic/OpenAI credentials are cleared
// so nothing can reach a provider directly.
// ---------------------------------------------------------------------------

const cpaApiKey = input("PI_ACTION_CPA_API_KEY");
const cpaBaseUrl = input("PI_ACTION_CPA_BASE_URL").replace(/\/+$/, "");
if (!cpaApiKey) fail("No gateway key supplied. Set `cliproxyapi-api-key`.");
if (!/^https?:\/\//.test(cpaBaseUrl)) fail("`cliproxyapi-base-url` must be an http(s) URL ending in /v1.");

// Bare model ids get the provider prefix; another provider has no credentials here.
function normalizeModel(raw, inputName) {
  let value = raw.trim();
  if (!value.includes("/")) value = `${PROVIDER_NAME}/${value}`;
  if (!value.startsWith(`${PROVIDER_NAME}/`)) {
    fail(`\`${inputName}\` must list gateway models (${PROVIDER_NAME}/<id>); got ${value}.`);
  }
  if (/\[[^\]]*\]$/.test(value)) {
    fail(
      `\`${inputName}\` ${value}: "[1m]"-style selectors are a Claude Code feature, not pi's. ` +
        "Pi takes the context window from the provider's model metadata; pass the bare id.",
    );
  }
  return value;
}
const modelIdOf = (model) => model.slice(PROVIDER_NAME.length + 1);

// Ordered and de-duplicated: the primary model first, then fallbacks as given.
const primaryModel = normalizeModel(input("PI_ACTION_MODEL") || `${PROVIDER_NAME}/claude-opus-5-5`, "model");
const fallbackModels = input("PI_ACTION_FALLBACK_MODELS")
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((value) => normalizeModel(value, "fallback-models"));
const modelChain = [...new Set([primaryModel, ...fallbackModels])];

const childEnv = { ...process.env };
for (const name of [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
]) {
  delete childEnv[name];
}
childEnv.CLIPROXYAPI_BASE_URL = cpaBaseUrl;
childEnv.CLIPROXYAPI_PROVIDER_NAME = PROVIDER_NAME;
childEnv.CLIPROXYAPI_API_KEY = cpaApiKey;

// Seed the extension's model snapshot before pi starts. On a cold runner the
// extension otherwise registers a placeholder and refreshes in the background,
// which a one-shot run never waits for: the model resolves as an unknown custom
// id and Claude goes out over openai-completions instead of anthropic-messages.
// This also validates the key, URL and model before any agent work starts.
let gatewayModels;
try {
  const response = await fetch(`${cpaBaseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${cpaApiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) {
    fail(`Gateway rejected the key (HTTP ${response.status}) at ${cpaBaseUrl}/models. Check \`cliproxyapi-api-key\`.`);
  }
  if (!response.ok) fail(`Gateway model discovery failed: HTTP ${response.status} at ${cpaBaseUrl}/models.`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) fail("Gateway /models response has no data array.");
  gatewayModels = body.data
    .filter((entry) => entry && typeof entry.id === "string" && entry.id.trim())
    .map(({ id, object, owned_by, created }) => ({ id, object, owned_by, created }));
} catch (error) {
  fail(`Gateway unreachable at ${cpaBaseUrl}/models: ${error instanceof Error ? error.message : String(error)}`);
}
// CPA's Codex-client catalog carries each model's context window, output limit and effort levels;
// plain /models does not, and a one-shot pi never fetches them itself. Optional: without them
// the extension falls back to pi's catalog and models.dev.
let modelSpecs = new Map();
try {
  const response = await fetch(`${cpaBaseUrl}/models?client_version=`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${cpaApiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  modelSpecs = parseModelSpecs(await response.json());
} catch (error) {
  warn(`Gateway model specs unavailable (${error instanceof Error ? error.message : String(error)}); using fallback model metadata.`);
}
// Every model in the chain is tried, listed or not: CLIProxyAPI hides a model
// it has suspended, and only a request through it clears that (lib/models.mjs).
// An unlisted model gets a synthetic snapshot entry so pi resolves it with real
// metadata; one the gateway really cannot serve fails fast on its first request
// and the attempt loop falls back.
const { unlisted: unlistedIds, snapshot: snapshotModels } = planModelChain(modelChain.map(modelIdOf), gatewayModels);
const unlistedModels = modelChain.filter((model) => unlistedIds.includes(modelIdOf(model)));
for (const model of unlistedModels) {
  warn(
    `${model} is not listed by the gateway's /models (suspended, cooling down, disabled or unknown); ` +
      "trying it anyway and falling back if it cannot answer.",
  );
}
// Mirrors the extension's cpaModelsCachePath(): ~/.cache/pi-cliproxyapi-provider/
// base64url("<provider>\n<baseUrl>")/cpa-models.json, envelope { fetchedAt, data }.
const snapshotDir = path.join(
  homedir(),
  ".cache",
  "pi-cliproxyapi-provider",
  Buffer.from(`${PROVIDER_NAME}\n${cpaBaseUrl}`).toString("base64url"),
);
mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(snapshotDir, "cpa-models.json"),
  `${JSON.stringify({ fetchedAt: Date.now(), data: withModelSpecs(snapshotModels, modelSpecs) }, null, 2)}\n`,
  { mode: 0o600 },
);
const gatewayHost = new URL(cpaBaseUrl).host;

// A GitHub App installation token (or an explicit `github-token`) replaces
// whatever GH_TOKEN the caller exported, so the agent's `gh` calls are
// attributed to that identity rather than github-actions[bot]. Distinct
// identities matter once more than one agent posts reviews: GitHub collapses
// review state per reviewer, so two workflows sharing github-actions[bot]
// overwrite each other's verdict.
const ghToken = input("PI_ACTION_GH_TOKEN");
if (ghToken) {
  childEnv.GH_TOKEN = ghToken;
  childEnv.GITHUB_TOKEN = ghToken;
}
const botLogin = input("PI_ACTION_BOT_LOGIN");
const botEmail = input("PI_ACTION_BOT_EMAIL");
if (botLogin && botEmail) {
  childEnv.GIT_AUTHOR_NAME = botLogin;
  childEnv.GIT_AUTHOR_EMAIL = botEmail;
  childEnv.GIT_COMMITTER_NAME = botLogin;
  childEnv.GIT_COMMITTER_EMAIL = botEmail;
}
const identity = botLogin || (ghToken ? "github-token" : "github-actions");

// The agent can read its own environment (e.g. /proc/self/environ), so tool output may carry these.
// Redact them before anything reaches the transcript artifact (public on a public repo), outputs or
// the step summary.
const STREAMING_EVENTS = new Set(["message_update", "tool_execution_update"]);
const guardedSecrets = [cpaApiKey, ghToken].filter((value) => value && value.length >= 8);
const redact = (text) => guardedSecrets.reduce((out, secret) => out.replaceAll(secret, "[REDACTED]"), text);

// Isolate the agent dir so no ambient ~/.pi state (settings, skills, stored
// credentials) can outrank what this action passes explicitly.
const runnerTemp = process.env.RUNNER_TEMP || process.env.TMPDIR || "/tmp";
const agentDir = path.join(runnerTemp, "pi-action-agent");
mkdirSync(agentDir, { recursive: true });
childEnv.PI_CODING_AGENT_DIR = agentDir;

// ---------------------------------------------------------------------------
// Build the pi invocation
// ---------------------------------------------------------------------------

const extensionDir = input("PI_ACTION_EXTENSION_DIR");
const extensionEntry = path.join(
  extensionDir,
  "node_modules",
  "@hank-warren",
  "pi-cliproxyapi-provider",
  "index.ts",
);
if (!existsSync(extensionEntry)) {
  fail(`Provider extension entry not found at ${extensionEntry}. The install step did not complete.`);
}
let providerVersion;
try {
  providerVersion = JSON.parse(readFileSync(path.join(path.dirname(extensionEntry), "package.json"), "utf8")).version;
} catch {
  providerVersion = undefined;
}

const messageThreadsInput = (input("PI_ACTION_MESSAGE_THREADS") || "false").toLowerCase();
if (!["true", "false"].includes(messageThreadsInput)) {
  fail("`message-threads` must be either `true` or `false`.");
}
const providerHasThreads = supportsMessageThreads(providerVersion);
if (messageThreadsInput === "true" && !providerHasThreads) {
  warn(`\`message-threads: true\` needs pi-cliproxyapi-provider 0.6.0 or later (installed: ${providerVersion}); ignored.`);
}
// The provider extension reads its settings from the agent dir's settings.json, then lets the
// checkout's .pi/settings.json override them whether or not pi trusts the project.
writeFileSync(
  path.join(agentDir, "settings.json"),
  `${JSON.stringify({ "pi-cliproxyapi-provider": { messageThreads: messageThreadsInput === "true" } }, null, 2)}\n`,
);
let messageThreads = providerHasThreads && messageThreadsInput === "true";
let messageThreadsSource = "input";
if (providerHasThreads) {
  // Read with the globally installed pi's own SettingsManager (lib/install-pi.sh), the loader the
  // provider uses, so the summary reports the value the provider actually sees.
  let projectSettings;
  try {
    const piRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const piEntry = path.join(piRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const { SettingsManager } = await import(pathToFileURL(piEntry).href);
    projectSettings = SettingsManager.create(process.cwd(), agentDir).getProjectSettings();
  } catch (error) {
    if (existsSync(path.join(process.cwd(), ".pi", "settings.json"))) {
      warn(
        `Could not read .pi/settings.json through pi (${error instanceof Error ? error.message : String(error)}); ` +
          "the summary's message-threads value may not reflect it.",
      );
    }
  }
  const projectThreads = projectMessageThreads(projectSettings);
  if (projectThreads !== undefined && projectThreads !== messageThreads) {
    warn(
      `.pi/settings.json sets pi-cliproxyapi-provider.messageThreads to ${projectThreads}, which overrides ` +
        `\`message-threads: ${messageThreadsInput}\` for the provider extension.`,
    );
    messageThreads = projectThreads;
    messageThreadsSource = ".pi/settings.json";
  }
}

const maxTurns = Number.parseInt(input("PI_ACTION_MAX_TURNS") || "25", 10);
if (!Number.isInteger(maxTurns) || maxTurns < 1) {
  fail("`max-turns` must be a positive integer.");
}

const timeoutMinutes = Number.parseFloat(input("PI_ACTION_TIMEOUT_MINUTES") || "20");
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  fail("`timeout-minutes` must be a positive number.");
}

const onRateLimit = (input("PI_ACTION_ON_RATE_LIMIT") || "fail").toLowerCase();
if (!["fail", "skip"].includes(onRateLimit)) {
  fail("`on-rate-limit` must be either `fail` or `skip`.");
}

const baseArgs = [
  "--print",
  "--mode",
  "json",
  "--no-session",
  // Explicit resource loading only: disable discovery, then hand back exactly
  // what the caller asked for. `--no-extensions` and `--no-skills` both keep
  // explicitly-passed paths.
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  // pi 1.0.4+ keeps MCP tools under --tools; the action never wants them.
  "--no-mcp",
  "--extension",
  extensionEntry,
];

const thinking = input("PI_ACTION_THINKING");
if (thinking) baseArgs.push("--thinking", thinking);

const tools = input("PI_ACTION_TOOLS");
if (tools) baseArgs.push("--tools", tools);

for (const skill of input("PI_ACTION_SKILL").split("\n").map((s) => s.trim()).filter(Boolean)) {
  if (!existsSync(skill)) fail(`Skill path does not exist: ${skill}`);
  baseArgs.push("--skill", skill);
}

const appendSystemPrompt = input("PI_ACTION_APPEND_SYSTEM_PROMPT");
if (appendSystemPrompt) baseArgs.push("--append-system-prompt", appendSystemPrompt);

// Load the provider once without a prompt. If it cannot start, it registers placeholder models,
// possibly at its default localhost URL with the gateway key, before saying so on stderr, so a
// prompted run could send a request before the runner reacts. `--list-models --offline` loads the
// extension exactly as the run will (same flags, env and cwd) and never sends a prompt.
const preflight = spawnSync(
  "pi",
  ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
    "--extension", extensionEntry, "--list-models", `${PROVIDER_NAME}/`],
  { env: childEnv, encoding: "utf8", timeout: 120_000 },
);
const preflightFailure = String(preflight.stderr ?? "")
  .split("\n")
  .map((line) => providerStartupFailure(redact(line)))
  .find((reason) => reason !== undefined);
if (preflightFailure !== undefined) {
  fail(
    `pi-cliproxyapi-provider ${providerVersion ?? ""} failed to start: ${preflightFailure.slice(0, 500)}. ` +
      "No request was sent. Check the provider's settings and config files in the checkout (.pi/).",
  );
}
if (preflight.error || preflight.status !== 0) {
  warn(
    `Provider preflight did not complete (${preflight.error?.message ?? `exit ${preflight.status}`}); ` +
      "a provider startup failure will be caught when the run starts.",
  );
}


// ---------------------------------------------------------------------------
// Run, falling back through the model chain
//
// A run that ends because its model cannot answer is re-run from scratch on
// the next model: quota exhausted (CPA 429 model_cooldown), model unknown to the
// gateway (400 model_not_found / "unknown provider for model"), or no usable
// credential (503 auth_unavailable / auth_not_found). Anything else ends the
// step. `timeout-minutes` is a budget for the whole step, shared by attempts.
// ---------------------------------------------------------------------------

const MODEL_UNAVAILABLE_PATTERN = /model_not_found|unknown provider for model|auth_unavailable|auth_not_found|no auth available/i;

const transcriptPath = path.join(runnerTemp, "pi-session.jsonl");
const transcript = createWriteStream(transcriptPath, { flags: "w" });
setOutput("transcript", transcriptPath);
const deadline = Date.now() + timeoutMinutes * 60 * 1000;

function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

function runAttempt(model, attempt) {
  return new Promise((resolve) => {
    transcript.write(`${JSON.stringify({ type: "pi_action_attempt", attempt, model })}\n`);
    const child = spawn("pi", [...baseArgs, "--model", model, prompt], {
      // PI_MODEL_ID lets a skill sign its output with the model actually
      // answering, including after a fallback (e.g. "Automated review by Pi - <id>").
      env: { ...childEnv, PI_MODEL_ID: modelIdOf(model) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let turnsStarted = 0;
    // pi auto-retries a failed request (429, 5xx) by re-entering the agent loop,
    // which emits a fresh turn_start. Those are not agent turns and must not
    // spend the cap.
    let retryPending = false;
    let retries = 0;
    let capExceeded = false;
    let timedOut = false;
    let finalText = "";
    let sawAgentEnd = false;
    // Error on the LAST assistant message: pi exits 0 even when the run ended on
    // an API error, and an earlier error that a retry recovered from must not count.
    let finalError = "";
    const toolCalls = [];
    const stderrChunks = [];
    // Set when the provider extension fell back to placeholder models (invalid settings, bad
    // config). pi then runs the model as an unknown custom id, bypassing the provider's routing.
    let providerFailure;

    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      Math.max(deadline - Date.now(), 0),
    );

    function handleEvent(event) {
      switch (event.type) {
        case "auto_retry_start":
          retryPending = true;
          retries += 1;
          break;
        case "turn_start":
          if (retryPending) {
            retryPending = false;
            break;
          }
          turnsStarted += 1;
          if (turnsStarted > maxTurns) {
            capExceeded = true;
            child.kill("SIGKILL");
          }
          break;
        case "tool_execution_start":
          if (event.toolName) toolCalls.push(event.toolName);
          break;
        case "message_end": {
          const text = extractText(event.message);
          if (event.message?.role === "assistant" && text.trim()) finalText = text;
          if (event.message?.role === "assistant") {
            finalError =
              event.message.stopReason === "error" ? String(event.message.errorMessage || "unknown error") : "";
          }
          break;
        }
        case "agent_end":
          sawAgentEnd = true;
          break;
        default:
          break;
      }
    }

    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (raw) => {
      const line = redact(raw);
      let event;
      try {
        event = line.trim() ? JSON.parse(line) : undefined;
      } catch {
        event = undefined; // non-JSON noise on stdout is recorded but not interpreted
      }
      // Streaming records are deltas, so a credential split across two of them escapes per-line
      // redaction. message_end and tool_execution_end carry the complete, redacted content.
      if (!STREAMING_EVENTS.has(event?.type)) transcript.write(`${line}\n`);
      if (event) handleEvent(event);
    });

    // Whole lines, so a credential split across two chunks is still redacted before it is logged.
    readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (raw) => {
      const text = `${redact(raw)}\n`;
      stderrChunks.push(text);
      process.stderr.write(text);
      if (providerFailure === undefined) {
        providerFailure = providerStartupFailure(text);
        if (providerFailure !== undefined) child.kill("SIGKILL");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      fail(`Failed to launch pi: ${error.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stderrText = stderrChunks.join("");
      // Judged on how the run ENDED: the last assistant message (also when the
      // timeout or turn cap killed pi mid-retry), or stderr when pi bailed before
      // emitting one. A 429 that a retry recovered from does not count.
      const endedOn = (pattern) => (finalError ? pattern.test(finalError) : code !== 0 && pattern.test(stderrText));
      const quotaExhausted = endedOn(QUOTA_EXHAUSTED_PATTERN);
      resolve({
        model,
        code,
        turns: Math.min(turnsStarted, maxTurns),
        retries,
        toolCalls,
        finalText,
        finalError,
        sawAgentEnd,
        timedOut,
        capExceeded,
        stderrTail: stderrText.trim().split("\n").slice(-20).join("\n"),
        providerFailure,
        quotaExhausted: providerFailure === undefined && quotaExhausted,
        modelUnavailable: providerFailure === undefined && !quotaExhausted && endedOn(MODEL_UNAVAILABLE_PATTERN),
      });
    });
  });
}

const attempts = [];
for (const [index, model] of modelChain.entries()) {
  process.stdout.write(
    `pi-action: model=${model} gateway=${gatewayHost} max-turns=${maxTurns} identity=${identity}` +
      (modelChain.length > 1 ? ` attempt=${index + 1}/${modelChain.length}` : "") +
      "\n",
  );
  const result = await runAttempt(model, index + 1);
  attempts.push(result);
  const next = modelChain[index + 1];
  const reason = result.quotaExhausted ? "quota exhausted" : result.modelUnavailable ? "model unavailable" : "";
  if (reason && next && Date.now() < deadline) {
    warn(`${model}: ${reason}; falling back to ${next}. ${result.finalError.slice(0, 200)}`);
    continue;
  }
  break;
}
await new Promise((resolve) => transcript.end(resolve));

const final = attempts[attempts.length - 1];
setOutput("turns", String(final.turns));
setOutput("result", final.finalText);
setOutput("model-used", final.model);
setOutput("rate-limited", final.quotaExhausted ? "true" : "false");

summary("### Pi agent run");
summary("");
summary(
  `| | |\n|---|---|\n| Model | \`${final.model}\` |\n| Gateway | ${gatewayHost} |\n| Identity | ${identity} |\n` +
    `| Turns | ${final.turns} / ${maxTurns} |\n| Retries | ${final.retries} |\n| Tool calls | ${final.toolCalls.length} |` +
    // Threads apply only to Claude models; omit the row when another model answered.
    (inferOwner(modelIdOf(final.model)) === "anthropic"
      ? `\n| Claude message threads | ${messageThreads ? "on" : "off"}` +
        `${messageThreadsSource === "input" ? "" : ` (from ${messageThreadsSource})`} |`
      : ""),
);
if (attempts.length > 1 || unlistedModels.length > 0) {
  summary("");
  summary("**Model chain**");
  summary("");
  for (const model of modelChain) {
    const result = attempts.find((attempt) => attempt.model === model);
    const outcome = !result
      ? "not tried"
      : result.providerFailure !== undefined
        ? "provider extension failed to start"
      : result.quotaExhausted
        ? "quota exhausted"
        : result.modelUnavailable
          ? "model unavailable"
          : result === final
            ? "answered"
            : "ended the run";
    const listing = unlistedModels.includes(model) ? "not listed by the gateway, " : "";
    summary(`- \`${model}\`: ${listing}${outcome}`);
  }
}
if (final.finalText) {
  summary("");
  summary("<details><summary>Final message</summary>\n");
  summary(final.finalText);
  summary("\n</details>");
}

const chainNote = modelChain.length > 1 ? ` (model chain: ${modelChain.join(", ")})` : "";
// Every model would hit the same failure, so the chain stops at the first attempt.
if (final.providerFailure !== undefined) {
  fail(
    `pi-cliproxyapi-provider ${providerVersion ?? ""} failed to start: ${final.providerFailure.slice(0, 500)}. ` +
      "No gateway model is usable; check the provider's settings and config files in the checkout (.pi/).",
  );
}
// Quota first: a run killed by the timeout while pi waited out a quota retry is
// out of quota, not hung.
if (final.quotaExhausted) {
  const detail = (final.finalError || final.stderrTail).trim().split("\n").slice(-3).join(" ").slice(0, 500);
  summary(`\n> **Quota exhausted.** ${detail}`);
  if (onRateLimit === "skip") {
    warn(`Gateway quota exhausted${chainNote}; skipping this run without failing. ${detail}`);
    process.stdout.write("pi-action: rate-limited, exiting 0 per on-rate-limit=skip.\n");
    process.exit(0);
  }
  fail(
    `Gateway quota exhausted${chainNote}. ${detail} ` +
      "Set `on-rate-limit: skip` to treat this as a non-failure.",
  );
}
if (final.modelUnavailable) {
  const listed = unlistedModels.includes(final.model)
    ? ` The gateway lists: ${gatewayModels.map((entry) => entry.id).sort().join(", ")}.`
    : "";
  fail(`Model unavailable at the gateway${chainNote}: ${final.finalError.slice(0, 500)}${listed}`);
}
if (final.timedOut) {
  fail(`Agent exceeded the ${timeoutMinutes} minute timeout.`);
}
if (final.capExceeded) {
  fail(
    `Agent exceeded the turn cap of ${maxTurns}. Raise \`max-turns\` or tighten the skill; ` +
      "a run that does not converge is not a passing run.",
  );
}
if (final.code !== 0) {
  if (final.stderrTail) process.stdout.write(`::group::pi stderr\n${final.stderrTail}\n::endgroup::\n`);
  fail(`pi exited with code ${final.code}.`);
}
if (final.finalError) {
  fail(`Agent run ended on a model error: ${final.finalError.slice(0, 500)}`);
}
if (!final.sawAgentEnd) {
  warn("pi exited 0 without emitting agent_end; the transcript may be truncated.");
}
if (!final.finalText) {
  warn("Agent produced no final assistant text.");
}

process.stdout.write(
  `pi-action: completed on ${final.model} in ${final.turns} turn(s), ${final.toolCalls.length} tool call(s).\n`,
);
