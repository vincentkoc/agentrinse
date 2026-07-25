# Architecture

AgentRinse separates evidence, policy, authorization, and mutation.

```text
CLI
  -> configuration
  -> read-only adapters
  -> validated audit report
  -> content-addressed plan
  -> authorization
  -> exclusive apply lock
  -> per-action revalidation
  -> same-parent isolation, worktree quarantine, or verified database copy
  -> type-specific executor
  -> durable run journal
```

## Contracts

Zod schemas validate resources, diagnostics, findings, reports, actions,
plans, runs, quarantine manifests, and database rollback manifests. Generated
JSON Schemas under `schemas/` are checked for drift in CI and shipped in the
npm package.

## Adapters

Collectors and classifiers are read-only. Provider and Docker adapters emit
protected findings by default. The Codex adapter may emit a versioned
experimental `database.vacuum` action after explicit audit opt-in. The artifact adapter can emit one exact
`artifacts.remove` action for each eligible configured directory. The Git
adapter can emit one exact `worktree.quarantine` action for each fully proven
inactive linked worktree.

No adapter mutates directly.

## Plan Engine

The plan engine selects eligible actions within the configured risk ceiling,
sorts them deterministically, records expected bytes, hashes canonical config
and audit input, sets a bounded expiration, and hashes the complete plan body.

## Apply Engine

The apply engine:

1. parses and verifies the complete plan
2. rejects state paths beneath cleanup targets
3. acquires the exclusive apply lock
4. creates the durable run journal
5. revalidates each action
6. records the isolation path before mutation
7. invokes the type-specific executor
8. records applied, stale, rolled-back, failed, partial, or interrupted outcomes
9. stops after an execution failure
10. finalizes the run and releases the owned lock

## Executors

The artifact executor performs a second inode check, atomically renames the
exact target to a same-parent tombstone, verifies the moved inode, removes the
tombstone, and verifies postconditions. It never searches for additional
targets.

The worktree executor creates a recovery ref, atomically renames the exact
linked worktree to a sibling owner-only quarantine directory, repairs and
locks its Git registration, then records a post-repair identity. Undo and purge
revalidate that identity before any recovery mutation.

The database executor creates a compacted same-filesystem sibling with
`VACUUM INTO`, verifies integrity and schema identity, retains the exact
original under AgentRinse state, then locks both SQLite inodes and atomically
exchanges the canonical and compacted paths. The locks remain held through
sidecar archival, manifest persistence, and directory fsync. Undo uses the same
locked exchange; purge shares the durable database manifest.

## State

Default state:

```text
$XDG_STATE_HOME/agentrinse/
  audits/<audit-id>.json
  plans/<plan-id>.json
  locks/apply.lock
  runs/<run-id>.json
  quarantine/<entry-id>.json
  database-backups/<entry-id>.json
  database-backups/<entry-id>-<filename>.original
```

Without `XDG_STATE_HOME`, the root is
`$HOME/.local/state/agentrinse`.

State records remain the execution source of truth. Audit JSON and NDJSON
stdout use versioned public output contracts. Human output is a projection of
validated records.
