/** Pure helpers for the pr-review apply step, kept apart so they are unit-testable. */

import { footer, marker, truncate } from "../lib/common.mjs";

export const REVIEW_MARKER = marker("pr-review");
export const VERDICTS = new Set(["approve", "request-changes"]);
export const DEFAULT_INSTRUCTIONS_FILE = ".github/pi/review.md";

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
 * A clean PR gets a one-line body whatever the agent wrote, so approvals stay
 * quiet. Findings get the agent's report. Both end with the footer and marker
 * the collapse step keys on.
 */
export function buildBody({ verdict, report, model, partial = false }) {
  const clean = partial
    ? "⚠️ No blocking issues in the changes I could see, but GitHub did not return the full diff, so this is not an approval."
    : "✅ No blocking issues.";
  const text = verdict === "approve" ? clean : truncate((report ?? "").trim(), 60000);
  if (!text) throw new Error("the review body is empty but the verdict is request-changes");
  return `${text}\n\n${footer("Automated review", model)}\n${REVIEW_MARKER}\n`;
}

/** Older reviews by this identity that carry the marker and are still expanded. */
export function supersededReviews(nodes, keepId) {
  return (Array.isArray(nodes) ? nodes : []).filter(
    (node) => node?.viewerDidAuthor && !node.isMinimized && node.id !== keepId && node.body?.includes(REVIEW_MARKER),
  );
}

/** This identity's earlier blocking reviews, which a non-approval does not clear. */
export function staleBlockingReviews(nodes, keepId) {
  return (Array.isArray(nodes) ? nodes : []).filter(
    (node) =>
      node?.viewerDidAuthor && node.state === "CHANGES_REQUESTED" && node.id !== keepId && node.body?.includes(REVIEW_MARKER),
  );
}

/** Credentials from a newline-separated list that appear in the text. */
export function leakedSecrets(text, list) {
  return String(list ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length >= 8 && String(text ?? "").includes(value));
}
