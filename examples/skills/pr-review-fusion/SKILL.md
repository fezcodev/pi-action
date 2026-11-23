---
name: pr-review-fusion
description: Synthesize multiple independent PR review reports into one verified, deduplicated pull request review.
---

# PR review fusion (customizable synthesizer skill)

Use this skill with the root `fezcodev/pi-action@v1` action when you want a custom multi-model
review pipeline (for example, combining reports from separate jobs or mixing `pi-action` with
another reviewer) instead of the turnkey `fezcodev/pi-action/pr-review-fusion@v1` sub-action.

The calling workflow passes the pull request context and anonymized candidate review files
(`reviewer-a.md`, `reviewer-b.md`, ...). Work read-only against the checkout.

## 1. Gather context

1. Read the PR diff and metadata (from prefetched files or `gh pr diff "$PR_NUMBER"`).
2. Read `AGENTS.md` / `CLAUDE.md` and any repo-specific review checklist.
3. Read every anonymized candidate report in `$CANDIDATES_DIR`. Keep reviewer identities
   anonymized (`Reviewer A`, `Reviewer B`) so you evaluate each finding on its evidence rather than
   which model produced it.

## 2. Verify and synthesize

Do not invent brand-new findings during synthesis — your job is to cluster, verify, and triage what
the independent reviewers raised:

1. **Cluster duplicates** pointing at the same underlying bug across reviewers.
2. **Verify every claim against the code on disk** (`path:line`, callers, guards, tests).
3. **Apply agreement + materiality:**
   - **Consensus (2+ reviewers):** High confidence. Keep as blocking if verified against the code
     and material under normal use.
   - **Single reviewer:** Skeptically verify. Keep as blocking only if you independently confirm a
     concrete, realistic, merge-blocking failure (correctness, security, data safety, operability,
     or missing test for changed behavior) with a clearly net-positive fix.
   - **Downgrade to Notes:** Real but minor caveats, low-probability edge cases, or follow-ups that
     should not block merge.
   - **Drop:** False positives, unverified API claims, contrived timing races, style nits, or
     tradeoffs already settled by a maintainer.

## 3. Output

Write one concise review (no "Reviewer A said..." meta-commentary). If you are posting directly via
`gh` from a workflow, or feeding a deterministic apply step, use:

```markdown
VERDICT: approve
```

With optional non-blocking notes:

```markdown
VERDICT: approve

**Notes**

- `path/to/file.ts:42`: brief non-blocking caveat.
```

With blocking findings:

```markdown
VERDICT: request-changes

**Findings**

1. `path/to/file.ts:42`: what is wrong, when it fails, and the fix in one sentence.
```
