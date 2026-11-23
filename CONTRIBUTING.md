# Contributing

## Layout

- `action.yml` and `runner.mjs`: the runtime. `lib/` holds shared helpers and their tests.
- `pr-review/`, `pr-review-fusion/`, `issue-triage/`, `issue-fix/`: composite sub-actions with their own skills.
- `examples/workflows/`: workflows to copy into a repository.
- `.github/workflows/`: this repository's own CI, smoke test, self-review and release.

## Checks

```bash
for f in runner.mjs lib/*.mjs */apply.mjs pr-review/*.mjs pr-review-fusion/*.mjs; do node --check "$f"; done
node --test
```

CI also checks that every action passes every `PI_ACTION_*` input the runner reads, that all actions
pin the same pi and provider versions, that the runner never sets provider credentials, and that the
pinned provider still writes its model snapshot where the runner seeds it.

The smoke test (`smoke.yml`) is manual because it spends gateway quota. Run it for runtime changes:

```bash
gh workflow run smoke.yml --ref <branch> -f model=cpa/gpt-6.2-sol
gh workflow run smoke.yml --ref <branch> -f model=cpa/claude-opus-5-5 -f message-threads=true
gh workflow run smoke.yml --ref <branch> -f model=cpa/gpt-6.2-sol -f use-github-token=true
```

## Pull requests

- One change per PR, with what changed, why, and what was tested in the description.
- Inputs and outputs are a public contract. Additions are fine in `v1`; removing or renaming an
  input, output or default needs a new major version.
- Bump `pi-version` and `provider-extension-version` in every `action.yml` together.

## Releases

Run the **Release** workflow with a version such as `1.3.0`. It tags the head of `main`, publishes a
GitHub release with generated notes, and moves the floating `v1` tag.
