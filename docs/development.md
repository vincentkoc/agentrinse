# Development Safety

Development and CI use synthetic homes only.

## Local Verification

```bash
pnpm check
pnpm smoke
pnpm pack:check
```

`pnpm check` runs formatting, lint, type checking, all unit and integration
tests, and JSON Schema drift verification.

`pnpm smoke` builds the CLI and:

1. creates a temporary synthetic home
2. writes synthetic provider resources and a project source file
3. creates one configured `node_modules` artifact
4. saves an audit and content-addressed plan
5. verifies preview does not mutate
6. applies the plan with an isolated state directory
7. verifies the exact artifact is gone
8. verifies the project source file remains
9. validates the completed run journal

It never reads `$HOME`.

## Fixture Rules

- create fixtures with `mkdtemp`
- never copy real transcripts or provider databases into Git
- replace personal paths with `/tmp` or `/fixture`
- never preserve real hostnames, usernames, tokens, emails, or IP addresses
- use fake process and owner-command runners where practical
- test every new mutation with stale identity, symlink, active process,
  rollback, partial failure, and source-preservation cases

## Remote Proof

Use a fresh Crabbox for packaged destructive scenarios. Install the packed
tarball like a user, construct only synthetic resources, exercise preview and
apply through the CLI, collect the run journal, and destroy the lease.
