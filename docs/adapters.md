# Adapter Matrix

All provider adapters are read-only in the current release.

| Adapter | Current capability | Protected state |
| --- | --- | --- |
| Codex | sessions, archived sessions, worktrees, diagnostic DB size | all |
| Claude | project sessions, debug logs, managed worktrees | all |
| Cursor | workspace state, global state, logs | all |
| GitHub Copilot | CLI sessions and logs | all |
| Zed | user-data root | all |
| OpenCode | database, logs, snapshots | all |
| Grok Build | version-gated data root | all |
| Git | explicit repository worktree porcelain | all |
| Docker | planned | all |

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
root. It uses `git worktree list --porcelain -z` and still protects every
worktree until activity and push-state collectors exist.

