# Adapter Matrix

Provider and Docker adapters are read-only. Artifact cleanup is scoped to
explicitly configured rebuildable directories. The Git adapter can emit one
recoverable whole-worktree action when every safety gate is proven.

| Adapter        | Current capability                                         | Protected state |
| -------------- | ---------------------------------------------------------- | --------------- |
| Codex          | sessions, archived sessions, worktrees, diagnostic DB size | all             |
| Claude         | project sessions, debug logs, managed worktrees            | all             |
| Cursor         | workspace state, global state, logs                        | all             |
| GitHub Copilot | CLI sessions and logs                                      | all             |
| Zed            | user-data root                                             | all             |
| OpenCode       | database, logs, snapshots                                  | all             |
| Grok Build     | version-gated data root                                    | all             |
| Runtime        | opt-in selected executable and Claude native versions      | all             |
| Git            | worktree audit and recoverable linked-worktree quarantine  | conditional     |
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
ref containment, configured remote-tracking refs, operation markers, complete
filesystem measurement, mount inspection, and live process ownership.

Only clean, unlocked, branch-attached, pushed, old, fully measured linked
worktrees without submodules or reachability roots can produce
`worktree.quarantine`. The action is `recoverable`, so the default `safe`
ceiling excludes it. Quarantine retains a locked Git registration and recovery
ref until undo or purge.

Codex and Claude metadata roots, explicit config pins, and the closeout
current-worktree root are shared with artifact classification. A nested
artifact never remains eligible after one of those roots is added.

### Runtime

Runtime inventory is opt-in. It reports selected Codex, Claude, Cursor,
Copilot, OpenCode, and Grok executables found on `PATH`. Unknown installation
managers remain `unknown`; AgentRinse recommends the owning installer or
package manager and proposes no action.

For Claude's documented native macOS/Linux layout, AgentRinse inventories
regular files under `$HOME/.local/share/claude/versions` and marks the version
selected by `$HOME/.local/bin/claude`. It does not infer staging names or
remove superseded versions.

### Docker

The Docker adapter is disabled by default. When explicitly enabled, it probes
the selected Docker context and inventories images and containers through
structured CLI output. Daemon failure degrades only Docker. Every resource is
protected and no prune command exists.
