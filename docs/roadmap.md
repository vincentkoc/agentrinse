# Roadmap

## 0.1: Operational Safe Artifacts

Shipped:

- provider, Git, and Docker inventory
- process ownership checks
- explicit artifact project roots
- versioned actions, plans, and run journals
- content-addressed plans and bounded expiry
- immediate revalidation
- exclusive lock with ownership-checked release
- atomic same-parent isolation
- rebuildable artifact removal
- generated JSON Schemas
- config initialization and doctor diagnostics
- history, show, partial-run guidance, and stale-lock recovery
- JSON envelopes, NDJSON events, and redacted audit export
- shell completion
- npm distribution with macOS and Linux package proof

## 0.2: Agent-Aware Reachability

Shipped:

- Git dirty, staged, untracked, operation, detached, and push-state proof
- provider session-to-worktree roots
- provider-managed worktree and pin roots
- runtime installation inventory
- report-only cleanup recommendations for protected provider state
- repository-scoped closeout profile and Mole dry-run handoff

## 0.3: Recoverable Worktrees

Shipped:

- recovery refs
- same-filesystem quarantine
- tested undo and expiry
- Homebrew distribution

The mutation boundary is limited to explicit recoverable worktree quarantine;
purge remains a separate destructive command.

## 0.4: Owner-Managed Maintenance

Shipped:

- recoverable offline compaction for current Codex state, logs, goals, and
  memories SQLite contracts
- exact migration/table checks, live-owner and descriptor refusal
- `VACUUM INTO`, full integrity proof, locked atomic exchange, undo, and expiry
  purge

## 0.5: Exact Provider Files

Shipped:

- shared recoverable provider-file quarantine, undo, purge, and recovery
- exact stale Claude debug-log quarantine
- exact Claude changelog-cache quarantine
- Claude native retention and Copilot native maintenance reporting

## 0.6: Additional Provider Policies

Current:

- exact stale Zed `Zed.log.old` quarantine
- native macOS, explicit-root, Flatpak, and XDG log-root resolution
- active Zed, descriptor, symlink, age, and exact-path refusal
- report-only OpenCode snapshot GC and server-log retention contracts
- exact Cursor global database and companion diagnostics
- report-only Cursor orphan KV GC and old-chat maintenance commands

Remaining:

- filtered Docker build-cache cleanup
- owner-managed old agent runtime removal

Every owner-specific mutation remains disabled until its current upstream
contract, offline requirements, and recovery behavior are proven.

## 1.0: Stable Contracts

- stable schema and exit-code compatibility policy
- cross-platform packaged proof
- recovery and threat-model review
- no known false-positive cleanup

No phase adds transcript deletion or Docker volume deletion.
