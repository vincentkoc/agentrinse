# Roadmap

## 0.1: Audit

- provider version probes
- session-to-worktree roots
- process ownership
- SQLite diagnostic facts
- OpenCode snapshot growth reporting
- Cursor workspace-path correlation
- custom Zed user-data discovery
- Grok Build source-version contract
- Docker networks, volumes, and build-cache inventory

## 0.2: Safe Actions

- versioned action descriptors
- persisted plan selection
- per-resource locks
- immediate revalidation
- interruption-safe run journal
- rebuildable worktree artifact removal
- filtered Docker build-cache cleanup

## 0.3: Recoverable Worktrees

- dirty, staged, untracked, stash, detached, and unpushed proof
- live process and session roots
- recovery refs
- same-filesystem quarantine
- undo and expiry

## 0.4: Offline Maintenance

- Codex log database compaction
- Cursor database diagnostics and optional compaction
- old agent runtime inventory and owner-managed removal
- Linux support

## 1.0: Stable Contracts

- stable JSON and NDJSON schemas
- stable diagnostic and exit codes
- Homebrew distribution
- recovery and threat-model review
- no known false-positive cleanup

No phase adds transcript deletion or Docker volume deletion.
