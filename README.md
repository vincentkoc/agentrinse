# agentrinse 🫧

audit first. clean deliberately. recover when it matters.

Use [storage inventory](docs/storage.md) to inspect hidden developer caches, retained state and virtual disk allocation.

## what is agentrinse?

agentrinse is a local-first cleanup planner for machines where coding agents,
worktrees, build artifacts, runtimes, and Docker state accumulate faster than
humans can safely reason about them.

it does not treat "old", "large", or "missing from the current terminal" as
proof that something is disposable. agentrinse inventories the machine,
reconstructs ownership and reachability, explains why every resource is
protected or eligible, creates a content-addressed plan, and revalidates the
same facts immediately before mutation.

agentrinse is not audit-only. audit establishes the evidence; apply performs
the approved filesystem, Git metadata, and offline database changes. `1.2.0`
removes exact configured rebuildable artifacts, quarantines proven inactive
linked worktrees, repairs and locks their Git registrations, restores
quarantined worktrees, permanently purges explicitly selected quarantine
entries, and compacts supported Codex SQLite state with a retained rollback
copy. It also quarantines exact stale Claude debug logs and changelog cache
files plus Zed's exact stale `Zed.log.old` rotated application log with a
seven-day undo window. OpenCode, Cursor, version-gated Docker Buildx, and
version-gated Grok owner maintenance remain report-only.

the point is confidence: make real cleanup changes without deleting the
session, branch, worktree, database content, or cache that another agent still
needs.
unknown state fails closed and recoverable worktrees are quarantined before
they can be purged.

agentrinse is deliberately not another generic disk cleaner. it understands
agent and Git ownership; [Mole](https://github.com/tw93/Mole) remains an
optional external handoff for broader macOS and project debris.

## cleanup actions

| Action                 | Risk         | What changes                                                                   | Recovery                                |
| ---------------------- | ------------ | ------------------------------------------------------------------------------ | --------------------------------------- |
| 🧹 artifact removal    | safe         | atomically isolates and removes an exact configured rebuildable directory      | rebuild from the project                |
| 🌿 worktree quarantine | recoverable  | moves a linked worktree, creates a recovery ref, and repairs Git registration  | `agentrinse undo <run-id>`              |
| 🧾 provider quarantine | recoverable  | moves an exact provider-owned disposable file into private recovery storage    | `agentrinse undo <run-id>`              |
| 🗜️ Codex DB vacuum     | experimental | builds and verifies a compacted SQLite copy, then retains the original file    | `agentrinse undo <run-id>` before reuse |
| ↩️ recovery undo       | recoverable  | restores a quarantined worktree, provider file, or database original           | recovery remains journaled              |
| 🗑️ recovery purge      | destructive  | permanently removes an explicitly selected worktree, provider file, or DB copy | none                                    |
| ⚙️ config init         | operational  | creates the default config without overwriting an existing file                | edit or remove the generated config     |
| 🔒 lock recovery       | operational  | removes only a stale AgentRinse lock after proving its process is gone         | rerun the interrupted command           |

provider sessions, transcripts, credentials, configuration, and logical
database records remain report-only. `1.2.0` supports explicit offline
compaction for the exact current Codex `state_5`, `logs_2`, `goals_1`, and
`memories_1` SQLite contracts. Claude cleanup is limited to exact old debug
text files and its rebuildable changelog cache. AgentRinse also reports
Claude's native retention policy and Copilot's native session and process-log
maintenance. It also reports OpenCode's owner-run snapshot compaction and its
separate append-only server log, plus Cursor's owner-run state database
maintenance. Docker inventories images, containers, and supported Buildx cache
records but remains audit-only. Grok inventory is pinned to the inspected
`0.2.112` version and build revision from the audited root's canonical
executable, and reports its session-start memory GC without invoking it.

## agent integrations

provider state is report-only unless the table below says otherwise.
agentrinse never erases transcripts, sessions, credentials, configuration, or
logical memory records.

| Logo                                                                        | Client                                                      | Mode                    | What it protects                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| <img width="48px" src="docs/client-openai.jpg" alt="OpenAI Codex" />        | [OpenAI Codex](https://github.com/openai/codex)             | audit + offline vacuum  | sessions, workspace roots, reachability, and supported SQLite state |
| <img width="48px" src="docs/client-claude.jpg" alt="Claude Code" />         | [Claude Code](https://code.claude.com/docs/en/overview)     | retention + quarantine  | sessions, caches, roots, native retention, and exact old files      |
| <img width="48px" src="docs/client-cursor.jpg" alt="Cursor" />              | [Cursor](https://cursor.com/docs)                           | audit + native guidance | workspace state, DB companions, and owner maintenance               |
| <img width="48px" src="docs/client-copilot.png" alt="GitHub Copilot CLI" /> | [GitHub Copilot CLI](https://github.com/github/copilot-cli) | audit + native guidance | local sessions, process logs, and provider-owned maintenance        |
| <img width="48px" src="docs/client-zed.svg" alt="Zed" />                    | [Zed](https://zed.dev/docs/ai/overview)                     | audit + quarantine      | local agent state and the exact stale rotated application log       |
| <img width="48px" src="docs/client-opencode.png" alt="OpenCode" />          | [OpenCode](https://opencode.ai/)                            | audit + native guidance | local state, snapshot GC, and server-log retention                  |
| <img width="48px" src="docs/client-openclaw.svg" alt="OpenClaw" />          | [OpenClaw](https://docs.openclaw.ai/)                       | audit + quarantine      | opt-in sessions, memory, managed worktrees, logs, and shell cache   |
| <img width="48px" src="docs/client-grok-build.svg" alt="Grok Build" />      | [Grok Build](https://docs.x.ai/build/overview)              | audit + native guidance | sessions, memory, logs, worktrees, caches, and owner maintenance    |

To audit one OpenClaw profile, run `agentrinse audit --providers openclaw --no-state --json`.
To include it in regular audits, set `adapters.openclaw.enabled` to `true` in the config.

## cleanup surfaces

| Icon                                                                        | Surface                              | Mode               | What it understands                                                     |
| --------------------------------------------------------------------------- | ------------------------------------ | ------------------ | ----------------------------------------------------------------------- |
| <img width="48px" src="docs/icon-git-branch.svg" alt="Git branch" />        | Git worktrees                        | audit + quarantine | linked worktrees, refs, dirtiness, locks, processes, and provider roots |
| <img width="48px" src="docs/icon-file.svg" alt="Build artifact file" />     | Build artifacts                      | safe-clean         | exact configured rebuildable directories                                |
| <img width="48px" src="docs/client-openai.jpg" alt="OpenAI Codex" />        | Codex SQLite state                   | experimental       | schema versions, free pages, sidecars, owner processes, and rollback    |
| <img width="48px" src="docs/client-claude.jpg" alt="Claude Code" />         | Claude native retention              | report-only        | default or user retention, settings validity, and provider ownership    |
| <img width="48px" src="docs/client-claude.jpg" alt="Claude Code" />         | Claude logs and changelog cache      | recoverable        | exact old files, provider liveness, seven-day undo, and explicit purge  |
| <img width="48px" src="docs/client-copilot.png" alt="GitHub Copilot CLI" /> | Copilot native maintenance           | report-only        | local session pruning and versioned process-log retention               |
| <img width="48px" src="docs/client-zed.svg" alt="Zed" />                    | Zed rotated application log          | recoverable        | exact `Zed.log.old`, provider liveness, seven-day undo, and purge       |
| <img width="48px" src="docs/client-opencode.png" alt="OpenCode" />          | OpenCode native maintenance          | report-only        | hourly snapshot GC and the append-only server-log contract              |
| <img width="48px" src="docs/client-cursor.jpg" alt="Cursor" />              | Cursor database maintenance          | report-only        | exact DB companions, orphan KV GC, and destructive chat cleanup         |
| <img width="48px" src="docs/client-grok-build.svg" alt="Grok Build" />      | Grok native memory GC                | report-only        | session-start orphan cleanup, source version, and explicit refusal      |
| <img width="48px" src="docs/icon-terminal.svg" alt="Terminal runtime" />    | Agent runtimes                       | audit-only, opt-in | installed agent executables and versions                                |
| <img width="48px" src="docs/client-docker-agent.svg" alt="Docker" />        | [Docker](https://docs.docker.com/)   | audit-only, opt-in | images, containers, and versioned Buildx cache                          |
| <img width="48px" src="docs/icon-search.svg" alt="Cleanup search" />        | [Mole](https://github.com/tw93/Mole) | suggestions only   | external dry-run cleanup opportunities on macOS                         |

## install

Node.js 22.12.0 or newer is required.

```bash
npm install -g agentrinse
# or
pnpm add -g agentrinse
# or
yarn global add agentrinse
# or
brew install vincentkoc/tap/agentrinse
```

one-off use:

```bash
npx agentrinse@1.2.0 doctor
```

then:

```bash
agentrinse --version
agentrinse doctor
agentrinse adapters
```

## quick rinse

inventory this machine's managed worktree containers before selecting repositories:

```bash
agentrinse worktrees
agentrinse worktrees --repo /src/project --project-roots --measure
agentrinse worktrees --root /work/current --root /work/legacy --repo /src/project --measure --json
gwt finish-status --all --read-only | agentrinse worktrees --root "$(gwt root)" --gwt-status-stdin --measure --json
```

the default checks `~/.codex/worktrees`, `$CODEX_HOME/worktrees` and
`$DOTFILES_WORKTREES_ROOT` where configured. Repeat `--root` to replace the
defaults. Supply `--repo` for owners with no surviving checkout in those roots.
For an OpenClaw primary checkout, `--openclaw-pr-gc-stdin` joins a native
`scripts/pr gc --dry-run` preview to direct PR directories and registrations.
It reports skipped and unreported PRs, checks for ignored or untracked work,
and separates measured logical bytes from unknown reclaim. Compare a frozen preview with a native apply log using `openclaw-pr-gc-diff`. See [OpenClaw PR
review checkouts](docs/storage.md#openclaw-pr-review-checkouts).

Add `--project-roots` to include existing `.worktrees` and `.claude/worktrees`
containers under each explicitly named primary checkout. Linked checkouts and
symlinked containers are reported as problems. A derived container also requires
a known local filesystem and no mount at or below the container or along its path
from the owner. Registrations outside the selected containers appear separately
with presence and owner. Conflicting Git registrations list every claiming owner
and mark the external path unresolved.
The scan covers direct checkouts and one grouping directory, with a 50,000-entry
discovery limit. Discovery and optional measurement have separate three-minute
budgets. `--max-entries` defaults to 10,000 per checkout. Size is the logical
file total excluding Git metadata, symlinks and nested mounts. Partial readings
are lower bounds. Administrative bytes count only direct regular files in Git
slots for missing checkouts, correlated by Git's backlink. Neither figure
predicts reclaimed disk space.

GWT input is optional. The command correlates native path records, Git registrations
and GWT creation locks. Finished checkouts with all owners released, and cancelled checkouts with matching cancellation HEADs,
are labelled for **native closeout review**. GWT status supplies provisional path evidence.
Its public summary omits the recorded creation token and finished HEAD. The allocator must revalidate HEAD,
owners, pins, holders, recovery state and shared dependencies. A directory's age
records its mtime, which cannot prove inactivity. This command writes no state
and has no apply mode.

from a Git worktree, inspect repository-scoped agent residue:

```bash
agentrinse clean --profile closeout
```

this audits the current repository, its linked worktrees, and relevant Codex
and Claude reachability metadata. the current worktree is always protected.
the command creates a plan but does not infer that your task is finished and
does not mutate anything unless `--apply` is present.

apply only reviewed `safe` artifact actions:

```bash
agentrinse clean --profile closeout --apply
```

automation must authorize explicitly:

```bash
agentrinse clean --profile closeout --apply --yes --max-risk safe --json
```

whole-worktree cleanup is recoverable and must be selected separately:

```bash
agentrinse clean --profile closeout --max-risk recoverable
agentrinse clean --profile closeout --max-risk recoverable --apply --yes
```

for an explicit repository fleet, repeat `--repo` and choose the risk ceiling:

```bash
agentrinse clean --profile fleet \
  --repo /path/to/repo-a \
  --repo /path/to/repo-b \
  --max-risk recoverable
```

fleet mode requires absolute `--repo` paths and never crawls the current
directory or home for repositories. linked-worktree aliases are deduplicated
by their physical Git common directory. add `--apply --yes` only after
reviewing the persisted plan.

that moves a proven inactive linked worktree into quarantine. it does not
reclaim disk immediately. restore it or inspect a later permanent purge:

```bash
agentrinse undo <run-id>
agentrinse purge --run <run-id>
agentrinse purge --run <run-id> --apply --yes
```

offline Codex database compaction is a separate experimental workflow. quit
every Codex CLI and desktop process first:

```bash
agentrinse audit --allow-offline-vacuum --output audit.json
agentrinse plan --audit audit.json --max-risk experimental --output plan.json
agentrinse apply --plan plan.json --max-risk experimental --yes
```

only databases with at least 512 MiB and 25 percent free pages are proposed.
apply holds exclusive SQLite-compatible file locks across an atomic path
exchange, so Codex cannot reopen either inode during installation. the original
file is retained for seven days. undo uses the same locked exchange and refuses
after Codex has reopened or changed the compacted database:

```bash
agentrinse undo <run-id>
agentrinse purge --expired
agentrinse purge --expired --apply --yes
```

apply reports zero reclaimed bytes while the original remains retained. run
journals record `retainedBackupBytes`; purge reports bytes only when that
rollback set is actually deleted.

## Git storage and linked registrations

```sh
agentrinse git-inventory --repo-root "$REPOSITORY_PARENT" --repo "$BARE_OWNER"
agentrinse git-inventory --repo-root "$REPOSITORY_PARENT" --json --redact
```

Each repository parent selects direct child owners, including hidden names. Repeat either option for additional locations. The read-only census covers direct pack files and sidecars, temporary-name aliases, direct `objects/bitmap-ref-tips_*` files, maintenance lock presence and native linked registrations. Missing checkouts can retain allocated blocks for Git administration. Compare their lock and prune flags separately. Use `--loose-objects` to also count regular loose-object names in the owner’s two-hex fanouts, using Git’s reported object format and the same entry budget. Checkout contents, object payloads, alternates and uniquely reclaimable filesystem extents are outside this measurement.

Add `--pack-headers` to count empty temporary packs and files containing exactly one recognized Git pack header. The probe opens at most 4,096 single-link `tmp_pack_*` files across the selected stores, reading at most 12 bytes per file. A header’s declared object count does not prove that any objects were written. Short files, unrecognized headers and files with more bytes remain unknown. A partial summary counts only observed names. If no selected store could be inspected, its summary has null counts. The report does not estimate reclaimable space from these counts.

The shared direct-file budget defaults to 1,000,000 entries. Use `--max-entries` up to 5,000,000 when coverage is partial. Byte counts in JSON are decimal strings. Name totals count directory entries. Global unique totals count device and inode pairs once. A changing identity is withheld. Temporary-only identities can still share extents or belong to an active writer.

All registrations of selected owners are inspected regardless of location. `--worktree-root "$CONTAINER"` labels an additional managed scope. To discover unregistered directories, use `agentrinse worktrees --root "$CONTAINER"`. Where the allocator supports it, pipe `gwt finish-status --all --read-only --inventory-json` into `git-inventory --gwt-status-stdin` with the same owner options. A legacy status array supplies signoff only. Native closeout review requires matching live bindings and recorded enrollment. Holders, protected history, merge status and recovery remain the allocator's responsibility.

Agent clients can load the operator instructions shipped at [skills/agentrinse/SKILL.md](skills/agentrinse/SKILL.md).

## commands

| Command                                   | Purpose                                                   | Mutation              |
| ----------------------------------------- | --------------------------------------------------------- | --------------------- |
| `agentrinse audit`                        | inventory a home and explain protection evidence          | none                  |
| `agentrinse audit --no-state --providers` | stream selected provider evidence without persisted state | none                  |
| `agentrinse audit --quick --providers`    | bounded selected-provider inventory without size scans    | none                  |
| `agentrinse audit --allow-offline-vacuum` | propose supported offline Codex DB actions                | none                  |
| `agentrinse plan`                         | create a bounded plan from a saved audit                  | persisted plan only   |
| `agentrinse clean --profile closeout`     | audit and plan the current repository                     | none                  |
| `agentrinse clean --profile fleet`        | audit and plan explicit repository roots                  | none                  |
| `agentrinse apply --plan <file>`          | revalidate and apply an authorized plan                   | selected actions      |
| `agentrinse undo <run-id>`                | restore recoverable actions from a run                    | recovery restore      |
| `agentrinse purge`                        | preview worktree and database recovery backups            | none                  |
| `agentrinse purge --apply --yes`          | permanently remove selected recovery backups              | destructive           |
| `agentrinse doctor`                       | diagnose platform, config, state, Git, and optional tools | none                  |
| `agentrinse storage-rules`                | list storage rules, scopes and required owner evidence    | none                  |
| `agentrinse storage`                      | inspect storage metadata and native volume counters       | none                  |
| `agentrinse adapters`                     | show adapter maturity and ownership                       | none                  |
| `agentrinse history`                      | list persisted cleanup runs                               | none                  |
| `agentrinse show`                         | inspect runs, plans, and resource findings                | none                  |
| `agentrinse lock status`                  | inspect the global apply lock                             | none                  |
| `agentrinse lock recover --yes`           | remove a stale lock after process proof                   | stale lock only       |
| `agentrinse config`                       | locate, initialize, show, or validate configuration       | `init` creates a file |
| `agentrinse completion <shell>`           | generate bash, zsh, or fish completion                    | none                  |

run `agentrinse <command> --help` for the complete option set.

## safety model

agentrinse is built around refusal:

1. **discover** resources through owner APIs and structured state where
   possible.
2. **protect** anything active, reachable, dirty, pinned, provider-managed, or
   unknown.
3. **plan** exact actions against canonical paths and measured identities.
4. **authorize** with an expiring, content-addressed plan and explicit risk
   ceiling.
5. **revalidate** paths, processes, refs, metadata, age, size, and provider
   roots under the mutation lock.
6. **isolate** the exact target with an atomic same-filesystem rename before
   removal.
7. **journal** every transition so interrupted work can be inspected,
   recovered, or undone.

there is no generic `--force` escape hatch.

agentrinse `1.2.0` never removes:

- provider sessions, transcripts, logical database rows, credentials, or configuration
- unsupported provider databases or Codex databases with unknown migrations
- plugins, skills, memories, or agent instruction files
- Git branches, stashes, the main worktree, or the current worktree
- Docker images, containers, networks, volumes, or build cache
- sockets, pipes, devices, mounts, or symlink targets

### build artifacts

direct removal is limited to exact names under explicitly configured project
roots:

```bash
agentrinse config init
agentrinse config path
agentrinse config policy
agentrinse config render --set '/worktrees/minAgeMinutes=4320' > review-profile.json
```

edit the generated JSON and add explicit artifact roots:

```json
{
  "schemaVersion": 1,
  "artifacts": {
    "projects": [
      {
        "root": "/absolute/path/to/project",
        "names": ["node_modules", "dist", ".cache"]
      }
    ],
    "minAgeMinutes": 1440,
    "minBytes": 67108864,
    "processCheck": "required"
  },
  "worktrees": {
    "minAgeMinutes": 20160,
    "quarantineTtlMinutes": 10080
  },
  "plan": {
    "ttlMinutes": 30,
    "maxRisk": "safe"
  }
}
```

supported artifact names:

- `node_modules`
- `dist`
- `dist-runtime`
- `build`
- `.next`
- `.turbo`
- `.cache`
- `coverage`
- `target`
- `.venv`

before removal, agentrinse revalidates configured scope, canonical path,
device and inode identity, recursive metadata fingerprint, measured bytes,
newest descendant age, mount boundaries, current working directories,
same-user processes, and plan expiration.

### worktree quarantine

a worktree is eligible for recoverable quarantine only when agentrinse can
prove that it is:

- linked, unlocked, branch-attached, clean, and pushed
- old enough under the configured policy
- free of submodules and active same-user processes
- outside the current and main worktrees
- not pinned by a Git ref, provider root, or active/recent agent session
- completely measured with no unknown ownership state

a recovery ref is created before the atomic move. Git registration is repaired
and locked, then the quarantine manifest is written with owner-only
permissions. permanent purge reloads configuration and provider metadata under
the mutation lock and refuses removal if any protection fact has changed.

## machine output

`--json` emits a versioned command envelope suitable for scripts and agent
tools:

```bash
agentrinse audit --json
agentrinse clean --profile closeout --json
agentrinse history --json
```

long audits can stream versioned events:

```bash
agentrinse audit --ndjson
```

headless checks can select exact providers without creating AgentRinse state:

```bash
agentrinse audit --providers cursor,copilot,opencode --no-state --json
```

`--no-state` requires JSON or NDJSON and rejects `--output` and `--state-dir`.
`--providers` accepts unique provider IDs only, honors configured provider
roots when they are absolute, and is valid only with `--no-state`. Git, Docker,
runtime, and artifact adapters are not instantiated for a provider-scoped
audit. The transient report omits candidate actions, so redirecting it into a
later plan cannot authorize cleanup.

for routine inventory, `--quick` implies `--no-state`, requires an exact
provider selection and JSON or NDJSON, disables recursive byte measurement,
skips action-oriented provider maintenance collection, and applies a 10-second
deadline to each probe, collection, and classification phase:

```bash
agentrinse audit --quick --providers codex,claude --ndjson
agentrinse audit --quick --providers cursor --phase-timeout 30s --json
```

deadline-limited output is degraded and partial. resources reported before a
collection deadline remain `unknown` with no candidate actions or reclaim
estimate. deadlines bound report latency and request cooperative cancellation;
signal-ignoring platform calls may settle later, and their late results are
ignored. quick output cannot enable apply, and it rejects offline-vacuum
proposals and persistence paths.

create a non-executable report for issue filing:

```bash
agentrinse audit --json --redact > audit-redacted.json
```

redaction replaces paths, salts identifiers per report, removes host fields,
and strips candidate actions. saved audit and plan evidence remains exact so
it can be verified before apply.

## platform support

| Platform       | `1.2.0` support                                                     |
| -------------- | ------------------------------------------------------------------- |
| macOS          | audit, artifact/worktree/Claude/Zed cleanup, DB vacuum, undo, purge |
| Linux          | audit, artifact/worktree/Claude/Zed cleanup, DB vacuum, undo, purge |
| WSL            | Linux contract inside the WSL filesystem                            |
| native Windows | audit-only                                                          |

Git and `lsof` are required for the complete diagnostic and process-ownership
contract. Codex DB maintenance additionally requires `sqlite3`. Docker is
optional. Mole detection is available on macOS.

## docs

- [configuration](docs/configuration.md)
- [automation](docs/automation.md)
- [recovery](docs/recovery.md)
- [safety model](docs/safety.md)
- [adapter matrix](docs/adapters.md)
- [platform support](docs/platforms.md)
- [architecture](docs/architecture.md)
- [cleanup rule and contributor map](docs/cleanup-rules.md)
- [development](docs/development.md)
- [release process](docs/releasing.md)
- [roadmap](docs/roadmap.md)
- [product specification](docs/product-spec.md)
- [security policy](SECURITY.md)

## development

```bash
pnpm install
pnpm check
pnpm smoke
pnpm pack:check
```

tests and smoke runs use guarded temporary synthetic roots. never point an
unreleased build at real developer state.

## status

`1.2.0` ships the complete audit → plan → revalidate → apply loop, safe
configured artifact cleanup, recoverable Git worktree, Claude file, and exact
Zed rotated-log quarantine, plus recoverable offline Codex database
compaction. Explicit fleet cleanup applies the same safety model across
repeated absolute repository roots, deduplicates linked aliases by physical
Git common directory, and isolates failed repositories. It reports OpenCode's
native maintenance contract, Cursor's owner database commands, Docker Buildx
cache facts, and Grok's version-gated session-start memory GC. Exact-provider
JSON and NDJSON audits can run without creating AgentRinse state and omit
candidate actions. Grok Build, Docker, and all other Cursor, Zed, and OpenCode
state remain non-mutating.

MIT licensed. built by [Vincent Koc](https://github.com/vincentkoc).
