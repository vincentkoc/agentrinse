# Adapter Matrix

Provider and Docker adapters are read-only except for versioned Codex database
maintenance, exact Claude debug-log and changelog-cache quarantine, and the
exact stale Zed rotated application log. Artifact cleanup is scoped to
explicitly configured rebuildable directories. The Git adapter can emit one
recoverable whole-worktree action when every safety gate is proven.

| Adapter        | Current capability                                        | Protected state |
| -------------- | --------------------------------------------------------- | --------------- |
| Codex          | sessions, worktrees, four SQLite DBs, offline compaction  | conditional     |
| Claude         | sessions, caches, native retention, exact file quarantine | conditional     |
| Cursor         | workspace state, exact global DB, native maintenance      | all             |
| GitHub Copilot | CLI sessions, logs, native maintenance guidance           | all             |
| Zed            | user-data root and exact rotated-log quarantine           | conditional     |
| OpenCode       | database, logs, snapshots, native maintenance guidance    | all             |
| Grok Build     | version-gated data root                                   | all             |
| Runtime        | opt-in selected executable and Claude native versions     | all             |
| Git            | worktree audit and recoverable linked-worktree quarantine | conditional     |
| Docker         | opt-in structured image/container/Buildx cache inventory  | all             |
| Artifacts      | exact configured rebuildable directories                  | conditional     |

## Artifact Rules

Artifact discovery is disabled until at least one project root and supported
name are configured. Eligible directories must be real, completely measured,
older and larger than configured thresholds, and proven idle by the process
ownership probe. Apply performs the full check again under the lock.

## Provider Rules

### Codex

JSONL sessions are durable replay state. SQLite is not treated as a complete
substitute and no rows are deleted. AgentRinse recognizes only
`state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, and
`memories_1.sqlite`, with their current SQLx migration versions and required
tables.

`audit --allow-offline-vacuum` may propose `database.vacuum` when free pages
are at least 512 MiB and 25 percent of the file. The action remains
`experimental`, so planning and apply also require
`--max-risk experimental`.

Compaction requires every Codex process stopped, no descriptor for the
database/WAL/SHM paths, no non-empty WAL, a successful quick check, sufficient
same-filesystem space, and an exact schema match. Zero-length WAL and SHM
companions are preserved with the rollback copy. Apply uses
`VACUUM INTO`, runs a full integrity check, fsyncs the output, retains the
original file, then holds POSIX record locks on both database inodes while an
atomic path exchange installs the compacted file. A second owner/descriptor
check runs after those locks are held and permits only AgentRinse's own file
descriptors.

### Claude

Transcripts, prompt history, checkpoint files, task state, settings,
credentials, plugins, undocumented caches, and native orphaned-worktree
cleanup stay provider-owned.

AgentRinse reports Claude's native startup retention for project sessions,
debug data, `paste-cache`, and `image-cache`. It reads only the direct user
`settings.json`, with a 1 MiB limit and stable-file check. A valid user
`cleanupPeriodDays` value is reported alongside Claude's documented 30-day
default, but never presented as globally effective because higher-precedence
settings are not resolved. AgentRinse validates only empty or retention-only
user settings objects; additional fields remain unverified rather than copying
Claude's full settings schema. Missing settings preserve the documented default
signal. Malformed, unreadable, changing, symlinked, oversized, invalid, or
unverified settings make native cleanup uncertain and emit no action.

Direct regular files matching `debug/*.txt` may produce
`provider.file-quarantine` after 30 days. The action is `recoverable`, excluded
by the default `safe` ceiling, retains the exact file for seven days, and
requires Claude to be stopped with no open descriptor. JSONL and nested paths
never match this policy.

The exact regular file `cache/changelog.md` may use the same recoverable
quarantine boundary after 30 days. [Claude's application-data
reference](https://code.claude.com/docs/en/claude-directory) documents it as a
release-notes cache that is refreshed in the background. AgentRinse does not
enumerate or mutate neighboring cache files, `paste-cache`, `image-cache`,
`remote-settings.json`, or `policy-limits.json`.

### Cursor

Workspace and global databases can carry chat history. A missing project path
does not make workspace storage disposable.

AgentRinse inventories the exact global
`User/globalStorage/state.vscdb` file and reports the byte size and file type
of its `.backup`, `-wal`, and `-shm` companions without following symlinks or
opening SQLite. Workspace storage and editor logs remain directory-level
report-only resources.

Cursor staff guidance current on 2026-07-13 documents two command-palette
operations:

- `Developer: GC Agent KV Blobs` removes orphaned agent KV blob data, preserves
  existing chats, then runs SQLite `VACUUM`
- `Developer: Delete Old Chats...` deletes chats older than a user-selected
  cutoff, then runs `VACUUM`

AgentRinse reports both commands with unknown confidence because it does not
probe the installed Cursor version. It never invokes either operation. The
second command is destructive logical history deletion and remains entirely
user-owned.

### GitHub Copilot

Configuration, authentication, custom agents, skills, and plugins are
permanent protection roots. Sessions and logs remain report-only.

AgentRinse reports Copilot's local-only `/session prune` command, including
dry-run support and the default protection for named and current sessions. It
also reports the process-log startup retention introduced in Copilot CLI
`1.0.52`: direct `process-*.log` files older than seven days or beyond the
newest 50 are provider-pruned, while extension logs are outside that contract.
The provider adapter does not execute Copilot to determine its installed
version, so both findings stay unknown-confidence and emit no action.

### Zed

Zed keeps its native macOS application logs under
`$HOME/Library/Logs/Zed`. Other platforms and explicit user-data roots keep
logs under the resolved data root's `logs` directory. Linux data-root
resolution honors absolute `FLATPAK_XDG_DATA_HOME` and `XDG_DATA_HOME` values.
Relative environment paths make discovery incomplete.

AgentRinse checks only the exact regular file `Zed.log.old`; it does not
enumerate the log directory. The file may produce
`provider.file-quarantine` after 30 days, with a seven-day undo window. The
action is `recoverable`, requires an explicit recoverable risk ceiling, and
requires all Zed and headless Zed processes stopped with no open descriptor.

The active `Zed.log`, ACP logs, neighboring files, databases, threads, crash
reports, settings, credentials, extensions, and every unknown Zed path remain
protected.

### OpenCode

Snapshot repositories are recovery state, not ordinary Git cache. AgentRinse
never runs Git garbage collection inside them.

The inspected OpenCode `1.18.9` source schedules its own snapshot
`git gc --prune=7.days` after a one-minute delay and repeats it hourly while
the snapshot service is active. AgentRinse reports that owner maintenance but
does not invoke it, because the installed OpenCode version is not probed.

The same source writes server logs by appending to
`$XDG_DATA_HOME/opencode/log/opencode.log` and defines no server-log retention
sweep. OpenCode Desktop's separate seven-day cleanup applies to its Electron
user-data log runs, not this server log directory. AgentRinse reports the
distinction and emits no action for either log surface.

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
structured CLI output. It also inventories cache records from the selected
healthy static builder when the installed Buildx version is within the
inspected `0.33.0` through `0.35.99` contract. Dynamic builders are rejected
because separate Buildx commands may select different workers. Static nodes
without stable worker IDs are also rejected.

When `DOCKER_HOST` selects an engine without `DOCKER_CONTEXT`, AgentRinse
preserves that host selection instead of adding `--context default`. It samples
the effective daemon and builder identity before and after collection and
discards results if either owner changes.

The cache facts include the context endpoint, daemon ID and version, selected
builder driver, stable worker IDs, record identity, type, size, mutability,
reclaimability, sharing, and conservative age evidence. Unsupported humanized
age text is retained but treated as recent evidence.

Numeric byte values remain exact measurements. Buildx humanized sizes are
rounded upstream, so AgentRinse preserves the displayed value and an
approximation in facts but omits exact measured and reclaimable-byte totals.

Daemon failure degrades only Docker. Missing, unsupported, or unhealthy Buildx
degrades only cache inventory; image and container inventory continues. Every
Docker resource is protected and no prune command exists. Buildx prune
re-resolves context and builder names in its own process and exposes no
conditional daemon/worker identity binding, so post-validation cannot prevent
the command from targeting a replacement owner.
