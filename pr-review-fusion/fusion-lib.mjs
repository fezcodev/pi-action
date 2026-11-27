/**
 * Pure helpers for pr-review-fusion: model parsing, diff file reordering,
 * GITHUB_OUTPUT parsing, outcome selection, and model label formatting.
 */

const PROVIDER_NAME = "cpa";

/** Normalize one gateway model id (mirroring runner.mjs). */
export function normalizeGatewayModel(raw, inputName = "models") {
  let value = String(raw ?? "").trim();
  if (!value) throw new Error(`\`${inputName}\` contains an empty model entry.`);
  if (!value.includes("/")) value = `${PROVIDER_NAME}/${value}`;
  if (!value.startsWith(`${PROVIDER_NAME}/`)) {
    throw new Error(`\`${inputName}\` must list gateway models (${PROVIDER_NAME}/<id>); got ${value}.`);
  }
  if (/\[[^\]]*\]$/.test(value)) {
    throw new Error(`\`${inputName}\` entry ${value} uses a bracketed context selector, which pi does not support.`);
  }
  const id = value.slice(PROVIDER_NAME.length + 1);
  if (!id) throw new Error(`\`${inputName}\` entry ${value} has no model id.`);
  return value;
}

/** Parse comma- or newline-separated gateway models, deduplicating while preserving order. */
export function parseModels(raw, inputName = "models", { required = true } = {}) {
  const entries = String(raw ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    if (required) throw new Error(`\`${inputName}\` must name at least one gateway model.`);
    return [];
  }
  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    const normalized = normalizeGatewayModel(entry, inputName);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      models.push(normalized);
    }
  }
  return models;
}

/** Strip the `cpa/` prefix for display labels. */
export function stripProviderPrefix(model) {
  return String(model ?? "").replace(/^cpa\//, "");
}

/** Anonymized slot label: 0 -> "A", 1 -> "B", ..., 25 -> "Z", 26 -> "27". */
export function slotLabel(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * Deterministically reorder file sections in a unified `git diff` so parallel
 * reviewers inspect files in different orders (reducing shared attention bias).
 * Seed 0 returns the canonical diff unchanged; diffs with fewer than 2 `diff --git `
 * sections are returned unchanged.
 */
export function reorderDiffFiles(diffText, seed = 0) {
  const text = String(diffText ?? "");
  if (!text || seed <= 0) return text;
  const starts = [];
  const headerRe = /^diff --git /gm;
  let match;
  while ((match = headerRe.exec(text)) !== null) {
    starts.push(match.index);
  }
  if (starts.length < 2) return text;

  const preamble = text.slice(0, starts[0]);
  const sections = starts.map((start, idx) => text.slice(start, idx + 1 < starts.length ? starts[idx + 1] : text.length));

  if (seed === 1) {
    return preamble + sections.reverse().join("");
  }

  // Deterministic LCG Fisher-Yates shuffle for 3+ reviewers.
  const copy = [...sections];
  let state = (seed * 1664525 + 1013904223) >>> 0;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return preamble + copy.join("");
}

/** Parse a GitHub Actions GITHUB_OUTPUT file (both `k=v` and `k<<DELIM\n...\nDELIM`). */
export function parseGithubOutput(text) {
  const outputs = {};
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const [, key, delimiter] = heredoc;
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        body.push(lines[i]);
        i++;
      }
      outputs[key] = body.join("\n");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) {
      outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return outputs;
}

/**
 * Parse parallel reviewer slots from comma- or newline-separated entries.
 * Each slot may list `|`-separated fallback models (e.g. `cpa/claude-opus-5-5 | cpa/gpt-6.2-sol`).
 */
export function parseModelSlots(raw, inputName = "models") {
  const entries = String(raw ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`\`${inputName}\` must name at least one gateway model.`);
  }
  return entries.map((entry) => {
    const parts = entry.split("|").map((part) => part.trim());
    if (parts.some((part) => !part)) {
      throw new Error(`\`${inputName}\` contains an empty fallback entry in '${entry}'.`);
    }
    const [model, ...rest] = parts.map((part) => normalizeGatewayModel(part, inputName));
    const seen = new Set([model]);
    const fallbacks = [];
    for (const candidate of rest) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        fallbacks.push(candidate);
      }
    }
    return { model, fallbacks };
  });
}

/** Format the footer model label for a fused review. */
export function formatModelLabel(reviewerModels, judgeModel = "") {
  const counts = new Map();
  for (const raw of reviewerModels) {
    const name = stripProviderPrefix(raw);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const judge = stripProviderPrefix(judgeModel);
  const base = parts.join(" + ");
  if (!judge || reviewerModels.length <= 1 || counts.has(judge)) return base || judge;
  return `${base} -> ${judge}`;
}

/**
 * Decide how to proceed after all parallel reviewer slots settle.
 *
 * Each run has:
 *   { slot, requestedModel, status: "ok" | "rate-limited" | "failed",
 *     modelUsed, result, verdict, report, error }
 *
 * Past the review round cap approvals carry no notes, so unanimous approvals short-circuit
 * even with notes and a lone surviving approval passes through as the bare verdict.
 */
export function decideFusionOutcome(runs, { pastCap = false } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const ok = list.filter((run) => run?.status === "ok");
  if (ok.length === 0) {
    const allRateLimited = list.length > 0 && list.every((run) => run?.status === "rate-limited");
    if (allRateLimited) return { action: "rate-limited" };
    const errors = list
      .filter((run) => run?.status === "failed")
      .map((run) => `${run.requestedModel}: ${run.error || "failed"}`);
    return { action: "fail", reason: errors.join("; ") || "no reviewer produced a result" };
  }
  if (ok.length === 1) {
    if (pastCap && ok[0].verdict === "approve") return { action: "short-circuit-approve", runs: ok };
    return { action: "passthrough", run: ok[0] };
  }
  const allCleanApprovals = ok.every(
    (run) => run.verdict === "approve" && (pastCap || !String(run.report ?? "").trim()),
  );
  if (allCleanApprovals) {
    return { action: "short-circuit-approve", runs: ok };
  }
  return { action: "synthesize", runs: ok };
}
