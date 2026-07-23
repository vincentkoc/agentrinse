# ADR 0001: Production Safety Boundary

Status: accepted

Date: 2026-07-23

## Context

AgentRinse currently audits provider state and emits empty plans. Shipping a
cleanup product requires a complete mutation path without granting broad
deletion rights to version-sensitive agent stores.

## Decision

The first production release will support one mutating action:

```text
artifacts.remove
```

The action applies only to exact artifact directories declared under explicit
project roots in configuration.

Every action requires:

1. a saved audit
2. a content-addressed plan
3. an unexpired authorization window
4. an exclusive state lock
5. path and filesystem identity revalidation
6. process-ownership revalidation
7. atomic same-parent isolation before recursive removal
8. a durable per-action run journal
9. postcondition verification

The release will not mutate:

- provider sessions, databases, logs, configuration, authentication, plugins,
  skills, memories, or snapshots
- Git worktrees, branches, stashes, or refs
- Docker containers, images, networks, volumes, or build cache
- undeclared paths

Git and Docker remain audit-only until their owner-specific safety and recovery
contracts are independently proven.

## Consequences

- AgentRinse has a useful production cleanup action without claiming unsafe
  provider lifecycle ownership.
- Configuration is intentionally explicit. There is no default whole-home
  artifact scan.
- The first release favors a narrow trustworthy capability over a wide
  destructive surface.
- Worktree quarantine and Docker cleanup remain later milestones.

## Validation

The production gate requires:

- synthetic unit and integration tests
- packed npm artifact installation
- Crabbox end-to-end proof of preview, apply, stale-plan refusal, symlink
  refusal, process-ownership refusal, and source preservation
- remote GitHub CI on the exact release candidate SHA
