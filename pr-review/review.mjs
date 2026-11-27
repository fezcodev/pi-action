/** Pure helpers for the pr-review apply step, kept apart so they are unit-testable. */

import { footer, marker, truncate } from "../lib/common.mjs";

export const REVIEW_MARKER = marker("pr-review");
export const VERDICTS = new Set(["approve", "request-changes"]);
export const DEFAULT_INSTRUCTIONS_FILE = ".github/pi/review.md";
export const DEFAULT_ROUND_CAP = 3;
export const HISTORY_FILE = "review-history.json";
export const SINCE_LAST_REVIEW_FILE = "since-last-review.patch";

const REVIEW_STATES = {
  APPROVED: "approve",
  CHANGES_REQUESTED: "request-changes",
  COMMENTED: "comment",
  DISMISSED: "dismissed",
};

/** Parse the `round-cap` input: empty means the default, otherwise a whole number from 1 to 20. */
export function parseRoundCap(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_ROUND_CAP;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 20) {
    throw new Error(`round-cap must be a whole number from 1 to 20, got '${text}'`);
  }
  return Number(text);
}

/**
 * Count this action's earlier review rounds from `reviews.json`. A round is one distinct
 * commit reviewed before `headSha`, so re-running on the same head adds none. Only Bot
 * reviews carrying the marker count; a person cannot move the count by quoting the marker.
 */
export function reviewHistory(reviews, headSha, roundCap = DEFAULT_ROUND_CAP) {
  const ours = (Array.isArray(reviews) ? reviews : [])
    .filter(
      (review) =>
        review?.author_type === "Bot" &&
        typeof review.body === "string" &&
        review.body.includes(REVIEW_MARKER) &&
        typeof review.commit_id === "string" &&
        review.commit_id,
    )
    .map((review, index) => ({ review, index, time: parseTimestamp(review.submitted_at) }))
    .sort((a, b) => (Number.isFinite(a.time) && Number.isFinite(b.time) && a.time !== b.time ? a.time - b.time : a.index - b.index))
    .map(({ review }) => review);
  const earlier = ours.filter((review) => review.commit_id !== headSha);
  const earlierRounds = new Set(earlier.map((review) => review.commit_id)).size;
  const last = earlier.at(-1);
  const round = earlierRounds + 1;
  return {
    round,
    round_cap: roundCap,
    past_cap: round > roundCap,
    earlier_rounds: earlierRounds,
    last_reviewed_sha: last?.commit_id ?? null,
    last_verdict: last ? (REVIEW_STATES[last.state] ?? String(last.state ?? "").toLowerCase()) : null,
  };
}

/**
 * Validate and normalize a repository-relative guidance file path.
 * Empty/whitespace returns ""; invalid paths throw so callers fail before calling the API.
 */
export function normalizeGuidancePath(raw) {
  if (raw == null) return "";
  if (typeof raw !== "string") throw new Error("instructions-file must be a string");
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error("instructions-file must not contain control characters");
  }
  if (trimmed.includes("\\")) {
    throw new Error("instructions-file must use '/' path separators");
  }
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new Error("instructions-file must be a repository-relative file path");
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("instructions-file must not contain empty, '.' or '..' path segments");
  }
  return segments.join("/");
}

/** Percent-encode each segment of a validated repo-relative path for the GitHub Contents API. */
export function encodeGuidancePath(normalizedPath) {
  return normalizedPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Decode a GitHub Contents API JSON payload for a guidance file.
 * Returns the UTF-8 text, or `null` when GitHub omits inline content (`encoding: "none"`, >1 MB)
 * so the caller can fetch the raw file body. Throws for directories, symlinks, or submodules.
 */
export function decodeContentsFile(payload, filePath) {
  if (!payload || Array.isArray(payload) || payload.type !== "file") {
    throw new Error(`'${filePath}' is not a regular file`);
  }
  if (payload.encoding === "base64" && typeof payload.content === "string") {
    return Buffer.from(payload.content, "base64").toString("utf8");
  }
  if (payload.encoding === "none") return null;
  throw new Error(`'${filePath}' returned unsupported content encoding '${payload.encoding ?? ""}'`);
}

/** Combine file-based and inline review instructions into one markdown document. */
export function combineGuidance(fileText, inlineText) {
  const parts = [fileText, inlineText].map((value) => String(value ?? "").trim()).filter(Boolean);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/**
 * Parse the agent's final message: a `VERDICT: <verdict>` line, then the review
 * body. Text before the verdict line (narration) is dropped.
 */
export function parseResult(text) {
  const lines = String(text ?? "").split("\n");
  const index = lines.findIndex((line) => /^\s*\**VERDICT:?\**\s*:?/i.test(line));
  if (index === -1) throw new Error("the final message has no VERDICT line");
  const verdict = lines[index]
    .replace(/^\s*\**VERDICT:?\**\s*:?/i, "")
    .replace(/[*`.]/g, "")
    .trim()
    .toLowerCase();
  return { verdict, report: lines.slice(index + 1).join("\n").trim() };
}

/** Validate the verdict and pick the review event for the mode. */
export function planReview(result, mode) {
  const verdict = typeof result?.verdict === "string" ? result.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.has(verdict)) {
    throw new Error(`verdict must be "approve" or "request-changes", got ${JSON.stringify(result?.verdict)}`);
  }
  let event = "COMMENT";
  if (mode === "verdict") event = verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";
  return { verdict, event };
}

/**
 * A clean PR gets a one-line body; an approval may also carry brief non-blocking
 * notes after it. Findings get the agent's report. Both end with the footer and
 * marker the collapse step keys on.
 */
export function buildBody({ verdict, report, model, partial = false }) {
  const clean = partial
    ? "⚠️ No blocking issues in the changes I could see, but GitHub did not return the full diff, so this is not an approval."
    : "✅ No blocking issues.";
  const trimmed = (report ?? "").trim();
  let text;
  if (verdict === "approve") {
    // Agent authors otherwise treat notes as work, and every fix push starts another round.
    const head = trimmed && !partial ? `${clean} The notes below are optional: nothing needs to change before merge.` : clean;
    text = trimmed ? `${head}\n\n${truncate(trimmed, 60000 - head.length - 2)}` : head;
  } else {
    if (!trimmed) throw new Error("the review body is empty but the verdict is request-changes");
    text = truncate(trimmed, 60000);
  }
  return `${text}\n\n${footer("Automated review", model)}\n${REVIEW_MARKER}\n`;
}

function parseTimestamp(value) {
  return typeof value === "string" && value.trim() ? Date.parse(value) : Number.NaN;
}

function submittedBefore(node, keep) {
  if (!node || !keep || node.id === keep.id) return false;
  const nodeTime = parseTimestamp(node.submittedAt);
  const keepTime = parseTimestamp(keep.submittedAt);
  if (!Number.isFinite(nodeTime) || !Number.isFinite(keepTime)) return false;
  if (nodeTime !== keepTime) return nodeTime < keepTime;
  return Number.isSafeInteger(node.databaseId) && Number.isSafeInteger(keep.databaseId) && node.databaseId < keep.databaseId;
}

function findKeep(nodes, keepId) {
  if (!Array.isArray(nodes) || !keepId) return null;
  const keep = nodes.find((node) => node?.id === keepId);
  return keep && Number.isFinite(parseTimestamp(keep.submittedAt)) ? keep : null;
}

/** True when `keepId` is present in `nodes` with a parseable submission time. */
export function hasReviewOrder(nodes, keepId) {
  return findKeep(nodes, keepId) !== null;
}

/**
 * Earlier marked reviews by this identity, strictly before `keepId`.
 * Returns empty when `keepId` or its submission time is missing so concurrent
 * runs never clean up a review whose order relative to this one is unknown.
 */
function priorReviews(nodes, keepId) {
  const keep = findKeep(nodes, keepId);
  if (!keep) return [];
  return nodes.filter(
    (node) => node?.viewerDidAuthor && node.body?.includes(REVIEW_MARKER) && submittedBefore(node, keep),
  );
}

/** Older reviews by this identity that carry the marker and are still expanded. */
export function supersededReviews(nodes, keepId) {
  return priorReviews(nodes, keepId).filter((node) => !node.isMinimized);
}

/**
 * Superseded reviews safe to collapse after posting the new review.
 *
 * Partial-diff runs never hide earlier findings. A full approval, a full
 * request-changes (which replaces earlier findings on the new head), or an
 * approval fallback that just dismissed earlier blocks collapses prior
 * `CHANGES_REQUESTED` reviews; comment-only mode leaves active blocks expanded.
 */
export function reviewsToCollapse(nodes, keepId, { event, plannedEvent = event, partialDiff = false } = {}) {
  if (partialDiff) return [];
  const replacesBlocking =
    event === "APPROVE" || event === "REQUEST_CHANGES" || (plannedEvent === "APPROVE" && event === "COMMENT");
  return supersededReviews(nodes, keepId).filter((node) => replacesBlocking || node.state !== "CHANGES_REQUESTED");
}

/** This identity's earlier blocking reviews, which a non-approval does not clear. */
export function staleBlockingReviews(nodes, keepId) {
  return priorReviews(nodes, keepId).filter((node) => node.state === "CHANGES_REQUESTED");
}

/** Credentials from a newline-separated list that appear in the text. */
export function leakedSecrets(text, list) {
  return String(list ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length >= 8 && String(text ?? "").includes(value));
}
