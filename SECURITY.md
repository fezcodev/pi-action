# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository. Do not open a public issue for a security problem.

Include the affected version or commit, the workflow configuration, and what an attacker can reach
(the gateway key, a GitHub token, write access to the repository). You will get an acknowledgement
within a few days.

## Supported versions

Fixes land on `main` and ship in the next `v1.x.y` release, and the floating `v1` tag moves to it.
Older tags are not patched.

## Trust model

- Run the action on `pull_request`, never on `pull_request_target` with the PR's code checked out.
  Fork PRs get no secrets under `pull_request`, and a same-repository author can already read them.
- The agent can read its own process environment, which holds the gateway key. The runner redacts
  the key and the agent's GitHub token from the transcript, outputs, step summary and stderr, but a
  model can re-encode a value it has seen.
- `pr-review` gives the agent read-only tools and no write token. A separate step mints or uses the
  posting token after the agent exits.
- Pin a full tag or commit SHA in workflows where a change to this action must not reach your CI
  without review.
