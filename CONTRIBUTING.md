# Contributing

AgentRinse handles valuable local developer state. Changes must prove their
safety boundary, not only their happy path.

## Setup

```bash
pnpm install
pnpm check
```

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
