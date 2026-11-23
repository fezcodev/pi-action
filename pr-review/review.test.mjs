import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_INSTRUCTIONS_FILE,
  REVIEW_MARKER,
  buildBody,
  combineGuidance,
  decodeContentsFile,
  encodeGuidancePath,
  leakedSecrets,
  normalizeGuidancePath,
  parseResult,
  planReview,
  staleBlockingReviews,
  supersededReviews,
} from "./review.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("parseResult reads the verdict line and the body after it", () => {
  assert.deepEqual(parseResult("VERDICT: approve"), { verdict: "approve", report: "" });
  assert.deepEqual(parseResult("Done reviewing.\n\n**VERDICT:** Request-Changes\n\n**Findings**\n\n1. `a.js:3`: boom\n"), {
    verdict: "request-changes",
    report: "**Findings**\n\n1. `a.js:3`: boom",
  });
  assert.equal(parseResult("Verdict: `approve`.").verdict, "approve");
  assert.throws(() => parseResult("Looks good to me."), /no VERDICT line/);
  assert.throws(() => parseResult(undefined), /no VERDICT line/);
});

test("planReview maps verdicts to events in verdict mode", () => {
  assert.deepEqual(planReview({ verdict: "approve" }, "verdict"), { verdict: "approve", event: "APPROVE" });
  assert.deepEqual(planReview({ verdict: " Request-Changes " }, "verdict"), {
    verdict: "request-changes",
    event: "REQUEST_CHANGES",
  });
});

test("planReview never blocks in comment mode", () => {
  assert.equal(planReview({ verdict: "request-changes" }, "comment").event, "COMMENT");
  assert.equal(planReview({ verdict: "approve" }, "comment").event, "COMMENT");
});

test("planReview rejects anything but the two verdicts", () => {
  assert.throws(() => planReview({ verdict: "lgtm" }, "verdict"), /verdict must be/);
  assert.throws(() => planReview({}, "verdict"), /verdict must be/);
});

test("buildBody keeps approvals to one line and ignores the report", () => {
  const body = buildBody({ verdict: "approve", report: "I checked everything.", model: "cpa/gpt-6.2-sol" });
  assert.match(body, /^✅ No blocking issues\.\n/);
  assert.doesNotMatch(body, /checked everything/);
  assert.match(body, /`gpt-6\.2-sol`/);
  assert.ok(body.trimEnd().endsWith(REVIEW_MARKER));
});

test("buildBody does not vouch for a PR whose full diff was unavailable", () => {
  const body = buildBody({ verdict: "approve", report: "", model: "", partial: true });
  assert.match(body, /not an approval/);
  assert.doesNotMatch(body, /✅/);
});

test("buildBody carries findings and refuses an empty blocking review", () => {
  const body = buildBody({ verdict: "request-changes", report: "1. `a.js:3`: boom\n", model: "" });
  assert.match(body, /^1\. `a\.js:3`: boom\n/);
  assert.ok(body.includes(REVIEW_MARKER));
  assert.throws(() => buildBody({ verdict: "request-changes", report: "  ", model: "" }), /empty/);
  assert.throws(() => buildBody({ verdict: "request-changes", report: null, model: "" }), /empty/);
});

const nodes = [
  { id: "a", viewerDidAuthor: true, isMinimized: false, state: "CHANGES_REQUESTED", body: `x\n${REVIEW_MARKER}` },
  { id: "b", viewerDidAuthor: true, isMinimized: true, state: "COMMENTED", body: `x\n${REVIEW_MARKER}` },
  { id: "c", viewerDidAuthor: false, isMinimized: false, state: "CHANGES_REQUESTED", body: `x\n${REVIEW_MARKER}` },
  { id: "d", viewerDidAuthor: true, isMinimized: false, state: "COMMENTED", body: "unrelated bot review" },
  { id: "e", viewerDidAuthor: true, isMinimized: false, state: "APPROVED", body: `ok\n${REVIEW_MARKER}` },
];

test("supersededReviews picks only this identity's expanded, marked reviews other than the new one", () => {
  assert.deepEqual(
    supersededReviews(nodes, "e").map((node) => node.id),
    ["a"],
  );
});

test("staleBlockingReviews picks this identity's marked change requests", () => {
  assert.deepEqual(
    staleBlockingReviews(nodes, "e").map((node) => node.id),
    ["a"],
  );
  assert.deepEqual(staleBlockingReviews(undefined, "e"), []);
});

test("leakedSecrets finds guarded credentials and ignores blanks", () => {
  const list = "\nabcdef0123456789\n  \nghs_shorttoken1\n";
  assert.deepEqual(leakedSecrets("key is abcdef0123456789 lol", list), ["abcdef0123456789"]);
  assert.deepEqual(leakedSecrets("nothing here", list), []);
  assert.deepEqual(leakedSecrets("x", undefined), []);
});

test("normalizeGuidancePath accepts repo-relative paths and rejects traversal or invalid paths", () => {
  assert.equal(normalizeGuidancePath(undefined), "");
  assert.equal(normalizeGuidancePath("   "), "");
  assert.equal(normalizeGuidancePath(" .github/pi/review.md\n"), DEFAULT_INSTRUCTIONS_FILE);
  assert.equal(normalizeGuidancePath("docs/review guidance.md"), "docs/review guidance.md");

  for (const bad of [
    "/etc/passwd",
    "docs/",
    "docs//review.md",
    "./review.md",
    "../secret.md",
    "docs/../review.md",
    "docs\\review.md",
    "docs/a\nb.md",
  ]) {
    assert.throws(() => normalizeGuidancePath(bad), /instructions-file/);
  }
  assert.throws(() => normalizeGuidancePath(123), /instructions-file/);
});

test("encodeGuidancePath encodes each segment without breaking slashes", () => {
  assert.equal(encodeGuidancePath(".github/pi/review.md"), ".github/pi/review.md");
  assert.equal(encodeGuidancePath("docs/review?ref=head#1.md"), "docs/review%3Fref%3Dhead%231.md");
  assert.equal(encodeGuidancePath("docs/my review 100%.md"), "docs/my%20review%20100%25.md");
});

test("decodeContentsFile decodes base64 files, signals raw fallback on encoding none, and rejects non-files", () => {
  const b64 = Buffer.from("# Review\nCheck migrations.\n", "utf8").toString("base64");
  assert.equal(decodeContentsFile({ type: "file", encoding: "base64", content: b64 }, "REVIEW.md"), "# Review\nCheck migrations.\n");
  assert.equal(decodeContentsFile({ type: "file", encoding: "base64", content: "" }, "REVIEW.md"), "");
  assert.equal(decodeContentsFile({ type: "file", encoding: "none", content: "" }, "REVIEW.md"), null);

  assert.throws(() => decodeContentsFile([{ type: "file" }], "docs"), /not a regular file/);
  assert.throws(() => decodeContentsFile({ type: "symlink", target: "../a" }, "REVIEW.md"), /not a regular file/);
  assert.throws(() => decodeContentsFile({ type: "submodule" }, "sub"), /not a regular file/);
  assert.throws(() => decodeContentsFile({ type: "file", encoding: "utf-8" }, "REVIEW.md"), /unsupported/);
});

test("combineGuidance merges file and inline instructions cleanly", () => {
  assert.equal(combineGuidance("", ""), "");
  assert.equal(combineGuidance("  \n ", "\t"), "");
  assert.equal(combineGuidance("File rule\n", ""), "File rule\n");
  assert.equal(combineGuidance("", "  Inline rule  "), "Inline rule\n");
  assert.equal(combineGuidance("File rule\n", "Inline rule\n"), "File rule\n\nInline rule\n");
});

test("fetch-guidance --validate accepts valid or empty paths and rejects bad paths", () => {
  const script = path.join(__dirname, "fetch-guidance.mjs");
  const ok = spawnSync(process.execPath, [script, "--validate"], {
    env: { ...process.env, PI_INSTRUCTIONS_FILE: "docs/review.md" },
    encoding: "utf8",
  });
  assert.equal(ok.status, 0);

  const empty = spawnSync(process.execPath, [script, "--validate"], {
    env: { ...process.env, PI_INSTRUCTIONS_FILE: "" },
    encoding: "utf8",
  });
  assert.equal(empty.status, 0);

  const bad = spawnSync(process.execPath, [script, "--validate"], {
    env: { ...process.env, PI_INSTRUCTIONS_FILE: "../escape.md" },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /::error title=pi-pr-review::/);
});
