# Adapter Matrix

All provider, Git, and Docker adapters are read-only. Artifact cleanup is
separately scoped to explicitly configured rebuildable directories.

| Adapter        | Current capability                                         | Protected state |
| -------------- | ---------------------------------------------------------- | --------------- |
| Codex          | sessions, archived sessions, worktrees, diagnostic DB size | all             |
| Claude         | project sessions, debug logs, managed worktrees            | all             |
| Cursor         | workspace state, global state, logs                        | all             |
| GitHub Copilot | CLI sessions and logs                                      | all             |
| Zed            | user-data root                                             | all             |
| OpenCode       | database, logs, snapshots                                  | all             |
| Grok Build     | version-gated data root                                    | all             |
| Git            | explicit repository worktree porcelain                     | all             |
| Docker         | opt-in structured image/container inventory                | all             |
| Artifacts      | exact configured rebuildable directories                   | conditional     |

## Artifact Rules

Artifact discovery is disabled until at least one project root and supported
name are configured. Eligible directories must be real, completely measured,
older and larger than configured thresholds, and proven idle by the process
ownership probe. Apply performs the full check again under the lock.

## Provider Rules

### Codex

JSONL sessions are durable replay state. SQLite is not treated as a complete
substitute. Database compaction remains an offline experimental feature.

### Claude

Native retention and orphaned-worktree behavior stays provider-owned.

### Cursor

Workspace and global databases can carry chat history. A missing project path
does not make workspace storage disposable.

### GitHub Copilot

Configuration, authentication, custom agents, skills, and plugins are
permanent protection roots. Sessions and logs are only inventoried.

### Zed

The user-data directory may be overridden. If the active directory cannot be
resolved, discovery is incomplete and cleanup must fail closed.

### OpenCode

Snapshot repositories are recovery state, not ordinary Git cache. AgentRinse
never runs Git garbage collection inside them.

### Grok Build

The storage contract is new and version-sensitive. Unknown versions degrade to
directory-level size reporting.

### Git

The Git adapter is disabled by default and requires an explicit repository
root. It uses `git worktree list --porcelain -z`, porcelain v2 status, local
ref containment, configured remote-tracking refs, operation markers, and live
process ownership. Whole-worktree removal remains unavailable in `0.2.0`.

Codex and Claude metadata roots, explicit config pins, and the closeout
current-worktree root are shared with artifact classification. A nested
artifact never remains eligible after one of those roots is added.

### Docker

The Docker adapter is disabled by default. When explicitly enabled, it probes
the selected Docker context and inventories images and containers through
structured CLI output. Daemon failure degrades only Docker. Every resource is
protected and no prune command exists.
