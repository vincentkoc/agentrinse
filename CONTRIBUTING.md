# Contributing

AgentRinse handles valuable local developer state. Changes must prove their
safety boundary, not only their happy path.

## Setup

Prerequisites:

- Node.js 22 or newer (`engines.node`); CI runs Node 22 and 24.
- pnpm at the version pinned in `package.json` (`packageManager`), for example
  through `corepack enable`.
- Git.
- `sqlite3` on `PATH`. The Codex database tests skip themselves when it is
  missing, so a run without it passes while leaving that code untested.
- `lsof` on macOS for the process-ownership tests.

```bash
pnpm install
pnpm check
```

Before opening a pull request, also run the package checks CI runs:

```bash
pnpm pack:check
pnpm smoke
pnpm smoke:package
```

See [docs/development.md](docs/development.md) for what each check covers.

## Requirements

- Add tests for malformed, missing, active, and changing state.
- Use temporary synthetic homes for all filesystem tests.
- Never include personal absolute paths, logs, transcripts, credentials, or
  real provider databases in fixtures.
- Keep provider session and configuration stores report-only unless an owner
  contract and recovery proof are documented.
- Update the product specification for new action types or safety rules.
- Use semantic commit messages.

## Pull Requests

Explain:

- the resource owner
- the evidence used for discovery
- the protection roots
- the proposed risk class
- revalidation behavior
- recovery behavior
- tests that prove refusal paths
