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
  hasReviewOrder,
  leakedSecrets,
  normalizeGuidancePath,
  parseResult,
  planReview,
  reviewsToCollapse,
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

test("buildBody keeps clean approvals to one line and preserves optional non-blocking notes", () => {
  const clean = buildBody({ verdict: "approve", report: "   ", model: "cpa/gpt-6.2-sol" });
  assert.match(clean, /^✅ No blocking issues\.\n\n<sub>/);
  assert.match(clean, /`gpt-6\.2-sol`/);
  assert.ok(clean.trimEnd().endsWith(REVIEW_MARKER));

  const noted = buildBody({
    verdict: "approve",
    report: "**Notes**\n\n- `a.js:12`: minor nit worth knowing.",
    model: "cpa/gpt-6.2-sol",
  });
  assert.match(noted, /^✅ No blocking issues\.\n\n\*\*Notes\*\*\n\n- `a\.js:12`: minor nit worth knowing\.\n\n<sub>/);
  assert.ok(noted.trimEnd().endsWith(REVIEW_MARKER));

  const huge = buildBody({ verdict: "approve", report: "x".repeat(65000), model: "cpa/gpt-6.2-sol" });
  assert.ok(huge.length < 65536);
  assert.match(huge, /truncated/);
});

test("buildBody does not vouch for a PR whose full diff was unavailable", () => {
  const body = buildBody({ verdict: "approve", report: "", model: "", partial: true });
  assert.match(body, /not an approval/);
  assert.doesNotMatch(body, /✅/);

  const noted = buildBody({ verdict: "approve", report: "**Notes**\n\n- Check the skipped lockfile.", model: "", partial: true });
  assert.match(noted, /not an approval/);
  assert.match(noted, /Check the skipped lockfile/);
});

test("buildBody carries findings and refuses an empty blocking review", () => {
  const body = buildBody({ verdict: "request-changes", report: "1. `a.js:3`: boom\n", model: "" });
  assert.match(body, /^1\. `a\.js:3`: boom\n/);
  assert.ok(body.includes(REVIEW_MARKER));
  assert.throws(() => buildBody({ verdict: "request-changes", report: "  ", model: "" }), /empty/);
  assert.throws(() => buildBody({ verdict: "request-changes", report: null, model: "" }), /empty/);
});

const nodes = [
  {
    id: "a",
    databaseId: 10,
    submittedAt: "2026-11-23T10:00:00Z",
    viewerDidAuthor: true,
    isMinimized: false,
    state: "CHANGES_REQUESTED",
    body: `x\n${REVIEW_MARKER}`,
  },
  {
    id: "b",
    databaseId: 11,
    submittedAt: "2026-11-23T10:01:00Z",
    viewerDidAuthor: true,
    isMinimized: true,
    state: "COMMENTED",
    body: `x\n${REVIEW_MARKER}`,
  },
  {
    id: "c",
    databaseId: 12,
    submittedAt: "2026-11-23T10:02:00Z",
    viewerDidAuthor: false,
    isMinimized: false,
    state: "CHANGES_REQUESTED",
    body: `x\n${REVIEW_MARKER}`,
  },
  {
    id: "d",
    databaseId: 13,
    submittedAt: "2026-11-23T10:03:00Z",
    viewerDidAuthor: true,
    isMinimized: false,
    state: "COMMENTED",
    body: "unrelated bot review",
  },
  {
    id: "e",
    databaseId: 15,
    submittedAt: "2026-11-23T10:05:00Z",
    viewerDidAuthor: true,
    isMinimized: false,
    state: "APPROVED",
    body: `ok\n${REVIEW_MARKER}`,
  },
];

test("supersededReviews picks only this identity's earlier expanded, marked reviews", () => {
  assert.deepEqual(
    supersededReviews(nodes, "e").map((node) => node.id),
    ["a"],
  );
});

test("reviewsToCollapse collapses prior change requests on newer full verdicts and approval fallbacks", () => {
  const mixed = [
    ...nodes,
    {
      id: "f",
      databaseId: 14,
      submittedAt: "2026-11-23T10:04:00Z",
      viewerDidAuthor: true,
      isMinimized: false,
      state: "COMMENTED",
      body: `note\n${REVIEW_MARKER}`,
    },
  ];

  assert.deepEqual(
    reviewsToCollapse(mixed, "e", { event: "REQUEST_CHANGES", plannedEvent: "REQUEST_CHANGES" }).map((n) => n.id),
    ["a", "f"],
  );
  assert.deepEqual(
    reviewsToCollapse(mixed, "e", { event: "APPROVE", plannedEvent: "APPROVE" }).map((n) => n.id),
    ["a", "f"],
  );
  assert.deepEqual(
    reviewsToCollapse(mixed, "e", { event: "COMMENT", plannedEvent: "APPROVE" }).map((n) => n.id),
    ["a", "f"],
  );
  // Comment-only mode never hides an active blocking review.
  assert.deepEqual(
    reviewsToCollapse(mixed, "e", { event: "COMMENT", plannedEvent: "COMMENT" }).map((n) => n.id),
    ["f"],
  );
  // Partial-diff runs never collapse earlier reviews.
  assert.deepEqual(
    reviewsToCollapse(mixed, "e", { event: "REQUEST_CHANGES", plannedEvent: "REQUEST_CHANGES", partialDiff: true }),
    [],
  );
});

test("cleanup never touches reviews newer than this run or when order cannot be established", () => {
  const withOverlap = [
    ...nodes,
    // Submitted in the same second as "e", earlier by databaseId.
    {
      id: "same-sec-older",
      databaseId: 14,
      submittedAt: "2026-11-23T10:05:00Z",
      viewerDidAuthor: true,
      isMinimized: false,
      state: "CHANGES_REQUESTED",
      body: `earlier\n${REVIEW_MARKER}`,
    },
    // Submitted in the same second as "e", newer by databaseId.
    {
      id: "same-sec-newer",
      databaseId: 16,
      submittedAt: "2026-11-23T10:05:00Z",
      viewerDidAuthor: true,
      isMinimized: false,
      state: "CHANGES_REQUESTED",
      body: `newer same sec\n${REVIEW_MARKER}`,
    },
    // Submitted in the same second as "e", missing databaseId (order ambiguous).
    {
      id: "same-sec-no-dbid",
      submittedAt: "2026-11-23T10:05:00Z",
      viewerDidAuthor: true,
      isMinimized: false,
      state: "CHANGES_REQUESTED",
      body: `ambiguous\n${REVIEW_MARKER}`,
    },
    // Submitted later by an overlapping run.
    {
      id: "later",
      databaseId: 20,
      submittedAt: "2026-11-23T10:05:05Z",
      viewerDidAuthor: true,
      isMinimized: false,
      state: "CHANGES_REQUESTED",
      body: `later\n${REVIEW_MARKER}`,
    },
    // Missing submittedAt (e.g. pending review).
    {
      id: "no-time",
      databaseId: 9,
      submittedAt: null,
      viewerDidAuthor: true,
      isMinimized: false,
      state: "CHANGES_REQUESTED",
      body: `pending\n${REVIEW_MARKER}`,
    },
  ];

  assert.equal(hasReviewOrder(withOverlap, "e"), true);
  assert.deepEqual(
    reviewsToCollapse(withOverlap, "e", { event: "REQUEST_CHANGES", plannedEvent: "REQUEST_CHANGES" }).map((n) => n.id),
    ["a", "same-sec-older"],
  );
  assert.deepEqual(
    staleBlockingReviews(withOverlap, "e").map((n) => n.id),
    ["a", "same-sec-older"],
  );

  // If this run's review is absent from the snapshot, skip cleanup completely.
  assert.equal(hasReviewOrder(withOverlap, "missing"), false);
  assert.deepEqual(
    reviewsToCollapse(withOverlap, "missing", { event: "APPROVE", plannedEvent: "APPROVE" }),
    [],
  );
  assert.deepEqual(staleBlockingReviews(withOverlap, "missing"), []);

  // If this run's review has no valid submittedAt, skip cleanup completely.
  const withoutKeepTime = nodes.map((n) => (n.id === "e" ? { ...n, submittedAt: null } : n));
  assert.equal(hasReviewOrder(withoutKeepTime, "e"), false);
  assert.deepEqual(
    reviewsToCollapse(withoutKeepTime, "e", { event: "APPROVE", plannedEvent: "APPROVE" }),
    [],
  );
  assert.deepEqual(staleBlockingReviews(withoutKeepTime, "e"), []);
});

test("staleBlockingReviews picks this identity's earlier marked change requests", () => {
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
