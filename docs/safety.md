# Safety Model

AgentRinse is designed around refusal. A resource becomes cleanable only after
its scope, identity, inactivity, and effect are positively known.

## Safe Artifact Mutation Boundary

Only `artifacts.remove` mutates:

- the project root is explicitly configured
- the artifact name is selected from the fixed supported-name enum
- the project and artifact are canonical real directories inside the physical
  audited home, with no symlink aliases in their paths
- the newest descendant exceeds the configured age threshold and the complete
  artifact exceeds the size threshold
- the complete measurement fits within the entry budget
- the tree contains only directories, regular files, and skipped symlinks;
  sockets, pipes, devices, and other special entries are blocked
- same-user process ownership is proven idle
- the action risk is `safe`

Provider state and Docker resources remain report-only except for the explicit
offline Codex database and exact provider-file boundaries below.

## Recoverable Provider File Boundary

`provider.file-quarantine` is a reusable `recoverable` executor for one exact
provider-owned regular file. No provider adapter emits it until a separate
owner-specific policy proves that the selected log or cache file is
disposable.

The action records and revalidates:

- an immutable provider-owned `policyId`
- the provider and canonical owner root
- the canonical path and exact relative path beneath that root
- regular-file and non-symlink type
- a single-link inode with no hard-link alias
- device, inode, full mode, mtime, and byte size
- a descriptor-bound streamed SHA-256 content digest and complete identity
  fingerprint
- stopped provider processes and no open file descriptor
- same-filesystem AgentRinse recovery storage
- unexpired plan authorization immediately before the atomic move

Apply refuses unless the policy registry binds that `policyId` to the
configured provider root and exact relative-path contract. It then opens the
physical provider root and every relative directory component with pinned
`openat` descriptors and `O_NOFOLLOW`, ties permission sealing to the validated
inode, temporarily removes write bits while repeating identity and liveness
checks, atomically moves the same inode with fd-relative no-replace rename,
restores the recorded mode, fsyncs both pinned directories, and persists the
moved identity.
Provider liveness matches provider-specific native executables, application
helpers, package markers, and interpreted or wrapped command lines. Incomplete
or unparseable process evidence fails closed, and process listing requests
untruncated command lines. The descriptor scan excludes only AgentRinse's own
validated file handle. If the final name changes inside the pinned parent at
rename time, AgentRinse atomically moves that unexpected inode back and records
a rolled-back action. Replacing an intermediate directory with a symlink cannot
redirect mutation outside the approved provider root.
Undo and purge use only the durable manifest and refuse ambiguous paths,
changed content, active providers, open descriptors, or cross-owned paths.
Undo keeps the restored inode write-sealed through directory sync and complete
content verification, then restores its recorded mode through the same
descriptor as the final mutation. Purge atomically renames the payload to a
deterministic owner-only claim path, verifies the claimed descriptor and inode,
then truncates the contents through a validated writable descriptor. The empty,
write-sealed inode remains as a durable purge proof, preventing pathname
rebinding from deleting unrelated content. Interrupted permission repair and
purge claims remain durable recovery states.
Directories, sessions, transcripts, databases, credentials, configuration,
plugins, and caches without an explicit file-level owner contract are not
accepted.

The registered Claude owner contracts are:

- `debug/*.txt`: one direct regular debug file
- `cache/changelog.md`: the exact rebuildable changelog cache

Both require a minimum age of 30 days and seven days of recoverable
quarantine. JSONL, nested paths, neighboring or undocumented cache files,
recent files, incomplete directory enumeration, active Claude processes, and
open descriptors remain protected.

## Native Provider Retention Reporting

Claude native retention is report-only. AgentRinse inventories project
sessions, debug data, `paste-cache`, and `image-cache`, then reports Claude's
documented `cleanupPeriodDays` startup sweep.

The user `settings.json` read is pinned to one direct regular file, capped at
1 MiB, and checked for stable device, inode, mode, timestamps, and size before
and after reading. AgentRinse reports a valid user value but does not call it
globally effective because higher-precedence settings are outside this
inspection. Only empty or retention-only user settings objects are validated;
additional fields preserve any observed cleanup period but make whole-file
validity unverified. Missing user settings retain the documented 30-day default
signal. Malformed, unreadable, changing, symlinked, oversized, invalid, or
unverified settings downgrade the finding to unknown confidence. AgentRinse
does not substitute the default or emit a cleanup action in that state.

## Recoverable Codex Database Boundary

`database.vacuum` is `experimental` and excluded by every lower risk ceiling.
It is limited to the exact current Codex SQLite filenames, expected SQLx
migration versions, and required tables.

The audit and apply boundaries require:

- explicit `--allow-offline-vacuum`
- at least 512 MiB and 25 percent free pages
- a successful SQLite quick check
- all Codex CLI, desktop, and app-server processes stopped
- no open descriptor for the database, WAL, or SHM paths
- no non-empty WAL; zero-length WAL and SHM companions are identity-tracked
  and moved into the rollback set
- enough free space for the second database plus a safety margin
- macOS or Linux with `sqlite3`, `lsof`, POSIX record locks, and atomic path
  exchange

Apply builds a sibling file with `VACUUM INTO`; it never runs in-place
`VACUUM`. The output is created inside an owner-only temporary directory. It
verifies the full integrity check, schema digest, complete SQLx
migration/checksum ledger, tables, migration version, and incremental
auto-vacuum mode and fsyncs the file. Immediately before mutation, AgentRinse
holds nonblocking whole-file POSIX record locks on the source and compacted
inodes and temporarily removes their write bits. It then repeats owner and
descriptor checks, verifies the locked main and sidecar identities, and
atomically exchanges the paths. Both inodes remain read-only and locked until
the original and its tracked sidecars are retained, directories are synced,
and the installed manifest is durable. Locks are released before the recorded
write modes are restored, preventing a waiting writer from following the old
inode through the exchange.

Undo is available only while the installed compacted identity is unchanged.
The identity includes a streamed SHA-256 digest of the complete main database
file. AgentRinse verifies both content digests, locks both inodes, repeats
owner, descriptor, and digest checks, and atomically exchanges them before
removing the displaced compacted copy. Once Codex reopens and writes the
database, automatic rollback is refused.
Expired original files are purged only after both copies pass full integrity
checks and the same sealed exclusion boundary revalidates the canonical
database, sidecars, and offline owner state. Normal post-vacuum writes disable
automatic undo but do not block purge while the canonical database still
matches the pinned Codex schema contract.

## Recoverable Worktree Boundary

`worktree.quarantine` is the only whole-worktree mutation. It is
`recoverable`, excluded by the default `safe` risk ceiling, and requires:

- a linked, branch-attached, unlocked, clean worktree
- configured remote reachability with no unpushed commit
- no Git operation, submodule, provider/session root, user pin, or live process
- complete filesystem measurement with no special entry or mount boundary
- age since the newest measured entry at or above the configured threshold
- macOS or Linux

Apply performs a fresh provider and Git audit under the mutation lock. It
creates an exact recovery ref, atomically renames the worktree into an
owner-only sibling quarantine directory, repairs the Git registration, locks
it, and records a post-repair identity. Cross-device fallback is forbidden.

Quarantine reclaims zero disk bytes. The run records moved bytes separately as
pending purge.

Undo refuses an occupied destination or any drift in content, filesystem
identity, process ownership, mount state, Git cleanliness, registration, or
recovery ref. It unlocks, renames, repairs, verifies, then deletes only the
recorded recovery ref.

Purge is a separate destructive command. It repeats the quarantine checks and
uses `git worktree remove` without `--force`. Changed or dirty quarantine state
is never purged.

## Authorization

Apply requires a saved content-addressed plan and interactive confirmation or
`--yes`. Machine-readable JSON mode requires `--yes` and never prompts on
stdout. The plan records:

- the audit and config digests
- the exact home, project root, artifact path, and filesystem identity
- measured bytes, newest descendant mtime, and recursive metadata fingerprint
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
4. device, inode, and root mtime identity
5. complete byte measurement, newest descendant mtime, and deterministic
   recursive metadata fingerprint including ctime
6. absence of sockets, pipes, devices, or other special filesystem entries
7. configured minimum size and newest-descendant age
8. current working directory ownership
9. same-user process cwd and file-descriptor ownership
10. absence of root or nested filesystem mount boundaries
11. unexpired plan authorization immediately before isolation

Any uncertainty produces `skipped-stale`. Apply never widens the action or
substitutes another target.

On Linux, AgentRinse reads same-user `/proc` state directly. If hardened procfs
settings prevent a complete scan, it falls back to `lsof`; if neither path can
prove the artifact idle, cleanup remains blocked.

## Isolation and Removal

An unchanged target is atomically renamed to a unique tombstone in the same
parent directory. The moved inode, recursive fingerprint, special-entry count,
mount boundaries, and process ownership are verified again before recursive
removal.

- authorization is checked again immediately before recursive removal
- mount boundaries are checked again immediately before removal
- the final inode check and production recursive removal run synchronously,
  without yielding to another JavaScript task
- expiration before isolation is `skipped-stale`
- expiration after isolation restores the original path and is `rolled-back`
- failure before removal restores the original path when possible
- a removal failure is `partially-applied`, even if the remaining tree is
  moved back, because some children may already be gone
- failure to verify postconditions after removal is `partially-applied`
- the journal records the last known recovery path
- successful removal verifies that both original and tombstone paths are gone

The concurrency contract covers ordinary tools and stale observations, not a
hostile process running as the same OS user. A same-user attacker can modify
the user's project and AgentRinse state directly; defending that boundary
requires OS isolation outside this package.

The operation is safe-class because supported artifacts are rebuildable. It is
not presented as undoable.

## State and Concurrency

Run journals use owner-only atomic writes, file fsync, directory fsync, and
same-directory rename. Each action transition is persisted before the next
mutation.

Execution errors are journaled separately from persistence errors. If deletion
succeeds but persisting `applied` fails, the durable action remains
`applying`; AgentRinse never rewrites the completed mutation as a failed one.

One global apply lock prevents concurrent runs. The record includes PID,
process start identity where available, hostname, command, plan ID, and run
ID. AgentRinse can recover a local lock only after proving the recorded process
is gone or the PID was reused. Age alone is never evidence. Recovery and
ordinary release both verify the lock token and inode before unlinking.

SIGINT is cooperative. AgentRinse completes any active isolation/removal
critical section, persists its exact outcome, and marks the run interrupted at
the next safe checkpoint.

The state directory is rejected if it is inside a planned cleanup target.
Quarantine manifests are schema-validated by doctor and retain the exact
original path, quarantine path, pre-move identity, post-move identity, TTL,
and last recovery state. Worktree entries also retain their recovery ref and
Git repair state.

## Hard Invariants

- discovery and planning never mutate
- unknown state is protected
- `/` and ancestors of the real home cannot be audit roots
- symlinks are not followed
- no process is killed
- no `sudo`
- no generic force flag
- no wildcard or unfiltered prune
- no `git worktree remove --force`
- no cross-device worktree copy-and-delete fallback
- no unsupported provider database mutation or logical row deletion
- no provider sessions, transcripts, credentials, configuration, plugins,
  skills, memories, branches, stashes, or Docker volumes are removed
- no action removes the current working directory or an ancestor
- failed and interrupted work remains visible in the durable journal
