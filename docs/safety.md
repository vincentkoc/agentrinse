# Safety Model

AgentRinse is designed around refusal. A resource becomes cleanable only after
its scope, identity, inactivity, and effect are positively known.

## Version 0.1 Mutation Boundary

Only `artifacts.remove` mutates:

- the project root is explicitly configured
- the artifact name is selected from the fixed supported-name enum
- the project and artifact are real directories inside the audited home
- the artifact exceeds configured age and size thresholds
- the complete measurement fits within the entry budget
- same-user process ownership is proven idle
- the action risk is `safe`

Provider state, Git worktrees, and Docker resources remain report-only.

## Authorization

Apply requires a saved content-addressed plan and interactive confirmation or
`--yes`. The plan records:

- the audit and config digests
- the exact home, project root, artifact path, and filesystem identity
- measured bytes
- the risk ceiling
- creation and expiration timestamps

Apply rejects invalid schemas, changed plan content, changed configuration,
future-dated plans, expired plans, duplicate targets, duplicate action IDs,
and inconsistent byte totals.

## Revalidation

After acquiring the exclusive lock, every action rechecks:

1. configured root and exact supported artifact name
2. lexical and realpath containment
3. directory and non-symlink type
4. device, inode, and mtime identity
5. complete byte measurement
6. current working directory ownership
7. same-user process cwd and file-descriptor ownership

Any uncertainty produces `skipped-stale`. Apply never widens the action or
substitutes another target.

## Isolation and Removal

An unchanged target is atomically renamed to a unique tombstone in the same
parent directory. The moved inode is verified again before recursive removal.

- failure before removal restores the original path when possible
- a removal failure is `partially-applied`, even if the remaining tree is
  moved back, because some children may already be gone
- the journal records the last known recovery path
- successful removal verifies that both original and tombstone paths are gone

The operation is safe-class because supported artifacts are rebuildable. It is
not presented as undoable.

## State and Concurrency

Run journals use owner-only atomic writes, file fsync, directory fsync, and
same-directory rename. Each action transition is persisted before the next
mutation.

One global apply lock prevents concurrent runs. A stale same-host lock is
reclaimed only when its recorded PID no longer exists. Release verifies the
lock token and inode before unlinking it.

The state directory is rejected if it is inside a planned cleanup target.

## Hard Invariants

- discovery and planning never mutate
- unknown state is protected
- `/` and ancestors of the real home cannot be audit roots
- symlinks are not followed
- no process is killed
- no `sudo`
- no generic force flag
- no wildcard or unfiltered prune
- no provider database mutation
- no provider sessions, transcripts, credentials, configuration, plugins,
  skills, memories, branches, stashes, or Docker volumes are removed
- no action removes the current working directory or an ancestor
- failed and interrupted work remains visible in the durable journal
