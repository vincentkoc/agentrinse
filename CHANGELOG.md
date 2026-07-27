# Changelog

All notable changes to AgentRinse will be documented in this file.

The project follows semantic versioning after its first supported release.

## [Unreleased]

### Added

- `agent-cache` resource identity for provider-owned disposable cache artifacts
- recoverable `provider.file-quarantine` execution, undo, purge, run-journal,
  manifest, and JSON Schema contracts for exact provider-owned regular files
- streamed content identity, provider-process and descriptor refusal,
  single-link inode enforcement, same-filesystem atomic moves, unexpected-inode
  rollback, crash reconciliation, and permission preservation for
  provider-file recovery
- descriptor-bound hashing, write-sealed restore verification, durable
  permission-repair recovery, nonblocking and size-bounded inspection, and
  deterministic purge claims that reclaim content through the validated
  descriptor while retaining an empty proof inode
- `openat`-pinned provider roots and parent directories, fd-relative atomic
  rename and sync, untruncated provider command-line inspection, and published
  JSON Schema branches that bind every action adapter to its target provider
- provider liveness detection for native, helper, interpreted, and wrapped
  command lines, with fail-closed incomplete process evidence
- recoverable quarantine for direct Claude `debug/*.txt` files older than 30
  days, with a seven-day undo window before purge
- recoverable quarantine for the exact Claude `cache/changelog.md` file after
  30 days, without matching neighboring or undocumented cache files
- report-only Claude native retention findings for sessions, debug data,
  managed worktrees, paste cache, and image cache, including the documented
  default and any valid user `cleanupPeriodDays`

### Fixed

- Claude discovery and provider-file authorization now share explicit root,
  absolute `CLAUDE_CONFIG_DIR`, and `$HOME/.claude` precedence and fail closed
  on relative environment values

### Safety

- no provider adapter emits the new action until a provider-specific owner
  contract registers a policy ID, configured owner root, and exact relative
  path contract for disposable log or cache files
- directories, symlinks, sessions, transcripts, databases, credentials,
  configuration, and ambiguous recovery state remain outside this boundary
- Claude cleanup excludes JSONL, nested paths, recent files, undocumented
  caches, active Claude processes, open descriptors, and incomplete directory
  enumeration
- malformed, unreadable, changing, symlinked, oversized, and invalid Claude
  settings make native retention uncertain instead of assuming the default or
  emitting an action

## [0.4.0] - 2026-07-25

### Added

- experimental `database.vacuum` actions for the current Codex state, logs,
  goals, and memories SQLite contracts
- explicit `audit --allow-offline-vacuum` discovery and matching
  `plan`/`apply --max-risk experimental` authorization
- free-page diagnostics, current SQLx migration/table checks, owner-process
  and exact descriptor refusal, non-empty WAL refusal, and tracked zero-WAL/SHM
  rollback
- `VACUUM INTO` compaction with full integrity proof, fsync, SQLite-compatible
  POSIX exclusion locks, temporary write-permission sealing, atomic path
  exchange, seven-day retained originals, strict locked undo, and expiry purge
- peak-space preflight, operation-specific long SQLite timeouts, and honest
  retained-backup versus reclaimed-byte accounting
- database backup manifests and generated JSON Schema

### Changed

- rewrote the public README around a faster product explanation, scannable
  agent coverage and command tables, install and closeout examples, and the
  shipped mutation, safety, and recovery boundaries, with visual integration
  icons matching TokenJuice

### Safety

- compaction never deletes SQLite rows and never runs in place
- unsupported filenames, migrations, tables, active Codex processes, open
  descriptors, non-empty WAL state, insufficient disk, integrity failures,
  and changed post-vacuum state fail closed

## [0.3.0] - 2026-07-24

### Added

- recoverable `worktree.quarantine` actions for fully proven inactive linked
  worktrees on macOS and Linux
- same-filesystem atomic quarantine with recovery refs, locked repaired Git
  registrations, durable manifests, and post-repair identity snapshots
- `agentrinse undo <run-id>` with exact destination, content, process, mount,
  Git state, and recovery-ref revalidation
- preview-first `agentrinse purge`, including expired-entry and explicit-run
  selection
- separate immediate-reclaim and pending-quarantine byte accounting
- quarantine schema validation in `doctor`
- recovery for interrupted pre-move, recovery-ref-created, and moved
  quarantine transitions
- fail-closed `undo` reconciliation for partial quarantine and purge-isolation
  transitions
- exact AgentRinse lock ownership checks and rollback of interrupted purge
  isolation failures
- unconditional selection and terminal finalization for already-started purge
  transitions
- mutation-time Git operation checks, moved-registration refusal, and reserved
  quarantine-container protection
- provider and pin protection refresh at the atomic quarantine boundary
- registered-worktree container refusal and symmetric relocated-registration
  checks during purge finalization
- atomic worktree-lock ownership handoff that preserves foreign locks and
  recovers interrupted AgentRinse lock claims
- mutation-locked purge protection refresh for path, resource, Git-ref,
  provider-managed, active-session, recent-session, and unknown-provider roots,
  including containing heads/remotes and exact tags, repeated at the
  permanent-removal boundary
- packaged end-to-end quarantine, undo, and clean purge smoke proof
- Homebrew distribution through `vincentkoc/tap`

### Safety

- the default `safe` risk ceiling excludes whole-worktree mutation
- quarantine requires an explicit `recoverable` ceiling, a clean pushed
  branch, complete measurement, no ignored or status-suppressed paths, no
  submodules, no live process, no pin or provider root, and at least the
  configured age
- detached, locked, dirty, busy, recent, unpushed, unknown-remote, prunable,
  cross-device, mounted, or incompletely inspected worktrees fail closed
- purge atomically isolates and revalidates the worktree before using
  `git worktree remove` without `--force`
- purge reloads current pins and provider metadata under the mutation lock;
  any matching or unknown protection root refuses permanent removal
- native Windows worktree mutation remains blocked

## [0.2.0] - 2026-07-24

### Added

- path, resource-id, and Git-ref pins with optional expiry
- Codex and Claude workspace roots derived from metadata without reading
  transcript bodies
- repository-scoped `clean --profile closeout` with persisted audit, plan,
  exact derived config, optional safe apply, compact JSON, and external Mole
  dry-run suggestions
- opt-in report-only inventory for selected agent executables and Claude
  native installed versions

### Safety

- malformed or unreadable provider metadata protects all affected Git
  worktrees instead of being treated as empty
- worktree and session roots suppress nested artifact actions

## [0.1.0] - 2026-07-24

### Added

- TypeScript npm package and `agentrinse` CLI
- MIT license and repository safety policy
- versioned audit, finding, resource, diagnostic, plan, action, and run
  contracts
- symlink-safe size measurement
- report-only adapters for Codex, Claude, Cursor, GitHub Copilot, Zed,
  OpenCode, and Grok Build
- opt-in report-only Git worktree and Docker adapters
- explicit rebuildable artifact discovery for configured project roots
- content-addressed cleanup plans with bounded authorization windows
- locked apply runs with immediate identity, size, path, and process
  revalidation
- same-parent atomic isolation before recursive artifact removal
- durable per-action run journals and partial-apply recovery paths
- versioned JSON Schemas
- packaged audit, plan, and apply smoke test
- configuration initialization and validation
- environment doctor, run history, record inspection, and owned stale-lock
  recovery
- versioned JSON envelopes, NDJSON audit events, and non-executable redacted
  audit output
- bash, zsh, and fish completion generation
- cooperative SIGINT handling with durable interrupted-run journals
- runtime guards for every destructive synthetic fixture

### Safety

- provider state, Git worktrees, Docker resources, branches, stashes,
  credentials, plugins, skills, memories, and Docker volumes remain
  report-only
- only exact configured rebuildable artifact directories can be removed
- unknown process ownership, symlinks, path drift, inode drift, size drift,
  expired plans, changed configuration, and concurrent runs fail closed
- no process killing, `sudo`, generic force flag, wildcard deletion, or
  unfiltered Docker prune

## [0.0.0] - 2026-07-24

### Added

- reserved the public `agentrinse` npm package name
- linked the package to the public source repository
- documented that the reservation release is unsupported for operational
  cleanup
