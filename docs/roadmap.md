# Roadmap

## 0.1: Safe Rebuildable Artifacts

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

## 0.2: Operational Visibility

- run history and journal inspection commands
- explicit stale-lock inspection and recovery command
- explicit partial-run recovery guidance
- richer provider diagnostics
- NDJSON event output
- shell completion
- Homebrew distribution

## 0.3: Recoverable Worktrees

- dirty, staged, untracked, stash, detached, and unpushed proof
- live process and session roots
- recovery refs
- same-filesystem quarantine
- tested undo and expiry

This phase requires a separate mutation-boundary decision.

## 0.4: Owner-Managed Maintenance

- Codex diagnostic and log database compaction
- Cursor database diagnostics and optional compaction
- provider-native retention operations
- filtered Docker build-cache cleanup
- old agent runtime inventory and owner-managed removal

Every owner-specific mutation remains disabled until its current upstream
contract, offline requirements, and recovery behavior are proven.

## 1.0: Stable Contracts

- stable schema and exit-code compatibility policy
- cross-platform packaged proof
- recovery and threat-model review
- no known false-positive cleanup

No phase adds transcript deletion or Docker volume deletion.
