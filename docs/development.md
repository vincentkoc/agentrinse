# Development Safety

Development and CI use synthetic homes only.

## Local Verification

```bash
pnpm check
pnpm smoke
pnpm smoke:package
pnpm pack:check
```

`pnpm check` runs formatting, lint, type checking, all unit and integration
tests, and JSON Schema drift verification.

`pnpm smoke` builds the CLI and:

1. creates a temporary synthetic home and passes the destructive-root guard
2. writes synthetic provider resources and a project source file
3. creates one configured `node_modules` artifact
4. saves an audit and content-addressed plan
5. verifies preview does not mutate
6. applies the plan with an isolated state directory
7. verifies the exact artifact is gone
8. verifies the project source file remains
9. creates a disposable Git remote, main worktree, and pushed linked worktree
10. audits and quarantines the linked worktree at `recoverable` risk
11. verifies zero immediate reclaim and durable pending bytes
12. restores it through `agentrinse undo`
13. quarantines it again and purges it through clean Git removal
14. verifies the path and Git registration are gone
15. validates the completed journals and quarantine manifests

It never reads data from `$HOME`.

## Fixture Rules

- create fixtures with `mkdtemp`
- call `assertDestructiveFixtureRoot` before any fixture can remove data
- keep destructive roots below the resolved OS temporary directory
- never use `/`, the temporary root itself, the real home, an ancestor of the
  repository checkout, or a path reached through an escaping symlink
- never copy real transcripts or provider databases into Git
- replace personal paths with `/tmp` or `/fixture`
- never preserve real hostnames, usernames, tokens, emails, or IP addresses
- use fake process and owner-command runners where practical
- test every new mutation with stale identity, symlink, active process,
  rollback, partial failure, and source-preservation cases
- worktree tests must use disposable repositories and must never target a
  developer checkout

## Remote Proof

Use a fresh Crabbox for packaged destructive scenarios. Install the packed
tarball like a user, construct only synthetic resources, exercise preview and
apply through the CLI, collect the run journal, and destroy the lease.
