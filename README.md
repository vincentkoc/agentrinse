# AgentRinse

Safe, local-first cleanup planning for agentic development.

AgentRinse inventories worktrees, agent state, logs, snapshots, and container
residue, explains why resources are protected, and produces deterministic
cleanup plans.

## Status

Pre-alpha and audit-only. The repository does not currently execute cleanup
actions.

Supported audit targets are being built for:

- Git worktrees
- OpenAI Codex
- Claude Code
- Cursor
- GitHub Copilot CLI
- Zed
- OpenCode
- Grok Build
- Docker

## Safety Model

- discovery is read-only
- unknown state is protected
- plans never mutate
- session stores are report-only
- no process killing
- no Docker volume deletion
- no generic `--force`
- tests use synthetic home directories

## Development

```bash
pnpm install
pnpm check
pnpm build
```

Do not run development builds against a real home directory. Use a synthetic
fixture:

```bash
pnpm build
node dist/cli.js audit --home ./test/fixtures/home --json
```

## License

MIT
