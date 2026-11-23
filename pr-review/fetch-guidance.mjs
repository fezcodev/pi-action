#!/usr/bin/env node
/**
 * Load optional review instructions for pr-review into `$PI_GUIDANCE_OUT`.
 *
 * - `--validate`: validate `PI_INSTRUCTIONS_FILE` before any token is minted.
 * - Default mode: fetch `PI_INSTRUCTIONS_FILE` (required if explicitly set) or
 *   `.github/pi/review.md` (optional when unset) from `PI_BASE_SHA`, then append
 *   inline `PI_INSTRUCTIONS` when provided.
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

import { env, fail, warn } from "../lib/common.mjs";
import {
  DEFAULT_INSTRUCTIONS_FILE,
  combineGuidance,
  decodeContentsFile,
  encodeGuidancePath,
  normalizeGuidancePath,
} from "./review.mjs";

const TITLE = "pi-pr-review";

let explicitPath;
try {
  explicitPath = normalizeGuidancePath(process.env.PI_INSTRUCTIONS_FILE);
} catch (error) {
  fail(TITLE, error.message);
}

if (process.argv.includes("--validate")) {
  process.exit(0);
}

const repo = env("PI_REPO");
const baseSha = env("PI_BASE_SHA");
const baseRef = env("PI_BASE_REF") || baseSha.slice(0, 7);
const outFile = env("PI_GUIDANCE_OUT");

if (!repo || !baseSha || !outFile) {
  fail(TITLE, "PI_REPO, PI_BASE_SHA and PI_GUIDANCE_OUT are required.");
}

function ghApi(route, extraArgs = []) {
  return spawnSync("gh", ["api", route, ...extraArgs], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function summarizeError(res) {
  const raw = (res.stderr || res.stdout || res.error?.message || "unknown error").trim();
  return raw.replace(/\s+/g, " ");
}

function isNotFound(res) {
  if (/HTTP 404\b/i.test(res.stderr || "")) return true;
  try {
    return String(JSON.parse(res.stdout || "{}")?.status) === "404";
  } catch {
    return false;
  }
}

const targetPath = explicitPath || DEFAULT_INSTRUCTIONS_FILE;
const route = `repos/${repo}/contents/${encodeGuidancePath(targetPath)}?ref=${encodeURIComponent(baseSha)}`;

let fileText = "";
const res = ghApi(route);
if (res.status !== 0) {
  const detail = summarizeError(res);
  if (explicitPath) {
    fail(TITLE, `instructions-file '${explicitPath}' could not be read from base branch '${baseRef}': ${detail}`);
  } else if (!isNotFound(res)) {
    warn(TITLE, `Could not read ${DEFAULT_INSTRUCTIONS_FILE} from base branch '${baseRef}' (${detail}); continuing without it.`);
  }
} else {
  try {
    const payload = JSON.parse(res.stdout);
    const decoded = decodeContentsFile(payload, targetPath);
    if (decoded !== null) {
      fileText = decoded;
    } else {
      const rawRes = ghApi(route, ["-H", "Accept: application/vnd.github.raw"]);
      if (rawRes.status !== 0) {
        throw new Error(summarizeError(rawRes));
      }
      fileText = rawRes.stdout;
    }
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ");
    if (explicitPath) {
      fail(TITLE, `instructions-file '${explicitPath}' on base branch '${baseRef}' is unusable: ${detail}`);
    } else {
      warn(TITLE, `Ignoring ${DEFAULT_INSTRUCTIONS_FILE} on base branch '${baseRef}' (${detail}).`);
    }
  }
}

const combined = combineGuidance(fileText, process.env.PI_INSTRUCTIONS);
if (combined) {
  writeFileSync(outFile, combined, "utf8");
} else {
  rmSync(outFile, { force: true });
}
