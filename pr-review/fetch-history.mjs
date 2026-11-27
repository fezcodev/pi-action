#!/usr/bin/env node
/**
 * Write the review round history for pr-review and pr-review-fusion into the context directory.
 *
 * - `--validate`: validate `PI_ROUND_CAP` before any token is minted.
 * - Default mode: read `pr.json` and `reviews.json` from `PI_CONTEXT_DIR`, write
 *   `review-history.json`, and, when an earlier round reviewed an ancestor of the head, the
 *   diff since that commit as `since-last-review.patch`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { env, fail, warn } from "../lib/common.mjs";
import { HISTORY_FILE, SINCE_LAST_REVIEW_FILE, parseRoundCap, reviewHistory } from "./review.mjs";

const TITLE = "pi-pr-review";

let roundCap;
try {
  roundCap = parseRoundCap(process.env.PI_ROUND_CAP);
} catch (error) {
  fail(TITLE, error.message);
}

if (process.argv.includes("--validate")) {
  process.exit(0);
}

const repo = env("PI_REPO");
const contextDir = env("PI_CONTEXT_DIR");
if (!repo || !contextDir) {
  fail(TITLE, "PI_REPO and PI_CONTEXT_DIR are required.");
}

const readJson = (name) => JSON.parse(readFileSync(path.join(contextDir, name), "utf8"));
const headSha = String(readJson("pr.json").head_sha ?? "");
const history = reviewHistory(readJson("reviews.json"), headSha, roundCap);

function ghApi(route, extraArgs = []) {
  return spawnSync("gh", ["api", route, ...extraArgs], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

const patchPath = path.join(contextDir, SINCE_LAST_REVIEW_FILE);
rmSync(patchPath, { force: true });
history.since_last_review = null;

if (history.last_reviewed_sha && headSha) {
  const route = `repos/${repo}/compare/${history.last_reviewed_sha}...${headSha}`;
  const status = ghApi(route, ["--jq", ".status"]);
  const compareStatus = status.status === 0 ? status.stdout.trim() : "";
  if (compareStatus === "ahead") {
    const diff = ghApi(route, ["-H", "Accept: application/vnd.github.diff"]);
    if (diff.status === 0) {
      writeFileSync(patchPath, diff.stdout, "utf8");
      history.since_last_review = SINCE_LAST_REVIEW_FILE;
    } else {
      history.since_last_review_unavailable = "GitHub did not return the diff since the last review";
    }
  } else {
    // A rebase or force-push leaves no clean incremental diff; reviewers fall back to the full diff.
    history.since_last_review_unavailable = compareStatus
      ? `the head is ${compareStatus} relative to the last reviewed commit (rebased or force-pushed)`
      : "the last reviewed commit is no longer reachable";
  }
  if (history.since_last_review_unavailable) {
    warn(TITLE, `No diff since the last review: ${history.since_last_review_unavailable}.`);
  }
}

writeFileSync(path.join(contextDir, HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`, "utf8");
process.stdout.write(
  `pi-pr-review: review round ${history.round} of cap ${history.round_cap}` +
    `${history.since_last_review ? `, diff since ${history.last_reviewed_sha.slice(0, 7)} attached` : ""}.\n`,
);
