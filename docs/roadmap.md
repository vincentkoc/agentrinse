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

- recovery refs
- same-filesystem quarantine
- tested undo and expiry
- Homebrew distribution

The mutation boundary is limited to explicit recoverable worktree quarantine;
purge remains a separate destructive command.

## 0.4: Owner-Managed Maintenance

- Codex diagnostic and log database compaction
- Cursor database diagnostics and optional compaction
- provider-native retention operations
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
