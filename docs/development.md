# Development Safety

Development and CI use synthetic homes only.

## Local Verification

```bash
pnpm check
pnpm smoke
pnpm pack:check
```

`pnpm smoke`:

1. creates a temporary directory
2. writes synthetic Codex and OpenCode fixtures
3. builds the CLI
4. audits the synthetic home
5. saves an audit and plan inside the temporary directory
6. verifies every finding is protected
7. verifies the plan contains zero actions

It does not read `$HOME`.

## Fixture Rules

- Create fixtures with `mkdtemp`.
- Never copy real transcripts or provider databases into Git.
- Replace personal paths with `/tmp` or `/fixture`.
- Do not preserve real hostnames, usernames, tokens, emails, or IP addresses.
- Use small synthetic files for size tests.
- Use fake command runners for Git and Docker unit tests.
- Use an isolated Crabbox for provider copies or destructive scenario proof.

## Crabbox Boundary

If real provider shape is required:

1. select the minimum required files
2. redact transcript contents and credentials
3. copy the fixture into a fresh isolated Crabbox
4. run AgentRinse only against the copied fixture root
5. destroy the remote fixture after proof

No development command should point AgentRinse at a workstation home.
