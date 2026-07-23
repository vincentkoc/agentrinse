# AGENTS.md

## Product Boundary

AgentRinse is a safety-critical local cleanup planner. Unknown state is
protected. A missing path, old timestamp, or large directory is never enough
evidence for deletion.

## Hard Safety Rules

- Never run AgentRinse against the developer's real home during development.
- Never point tests at `$HOME`, `/`, a repository parent, or a non-temporary
  directory.
- Use synthetic fixtures under a test-owned temporary root.
- Do not add a mutating action without plan, revalidation, journal, and
  recovery tests.
- Do not kill Codex, Claude, Cursor, Copilot, Zed, OpenCode, Grok, Docker,
  tmux, terminal, SSH, or test processes.
- Do not delete transcripts, session databases, credentials, configuration,
  skills, memories, plugins, Docker volumes, Git branches, or stashes.
- Do not follow symlinks during size measurement or cleanup.
- Do not execute project-provided hooks or configuration as code.
- Never add a generic `--force` override.

## Engineering

- TypeScript ESM with exact `.js` suffixes in relative imports.
- Keep collectors read-only.
- Keep policy separate from discovery.
- Machine output is a versioned contract.
- Human output must not be parsed by other modules.
- Use owner APIs and structured output before filesystem inference.
- Tests mirror source ownership and use explicit fake homes.
- Prefer one focused commit per contract, adapter, or behavior.

## Verification

Before commit:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Before publish:

```bash
pnpm pack:check
```

