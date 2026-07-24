# agentrinse 🫧

fail-closed cleanup for developer agent state and Git worktrees.

## what is agentrinse?

agentrinse is a local-first cleanup planner for machines where coding agents,
worktrees, build artifacts, runtimes, and Docker state accumulate faster than
humans can safely reason about them.

it does not treat "old", "large", or "missing from the current terminal" as
proof that something is disposable. agentrinse inventories the machine,
reconstructs ownership and reachability, explains why every resource is
protected or eligible, creates a content-addressed plan, and revalidates the
same facts immediately before mutation.

the point is confidence: clean up after agentic development without deleting
the session, branch, worktree, database, or cache that another agent still
needs. unknown state fails closed. recoverable worktrees are quarantined before
they can be purged. exact configured build artifacts are the only direct
safe-clean surface.

agentrinse is deliberately not another generic disk cleaner. it understands
agent and Git ownership; [Mole](https://github.com/tw93/Mole) remains an
optional external handoff for broader macOS and project debris.

## agent coverage

provider state is report-only. agentrinse uses it to protect resources, never
to erase transcripts, sessions, credentials, configuration, or memories.

| Adapter            | Mode               | What it understands                                                     |
| ------------------ | ------------------ | ----------------------------------------------------------------------- |
| OpenAI Codex       | audit-only         | sessions, workspace roots, and reachability                             |
| Claude Code        | audit-only         | sessions, workspace roots, and reachability                             |
| Cursor             | audit-only         | local agent state and workspace references                              |
| GitHub Copilot CLI | audit-only         | local session and configuration state                                   |
| Zed                | audit-only         | local agent state                                                       |
| OpenCode           | audit-only         | local agent state                                                       |
| Grok Build         | audit-only         | local agent state                                                       |
| Git worktrees      | audit + quarantine | linked worktrees, refs, dirtiness, locks, processes, and provider roots |
| Build artifacts    | safe-clean         | exact configured rebuildable directories                                |
| Agent runtimes     | audit-only, opt-in | installed agent executables and versions                                |
| Docker             | audit-only, opt-in | images and containers                                                   |
| Mole               | suggestions only   | external dry-run cleanup opportunities on macOS                         |

## install

Node.js 22 or newer is required.

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
npx agentrinse@0.3.0 doctor
```

then:

```bash
agentrinse --version
agentrinse doctor
agentrinse adapters
```

## quick rinse

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

that moves a proven inactive linked worktree into quarantine. it does not
reclaim disk immediately. restore it or inspect a later permanent purge:

```bash
agentrinse undo <run-id>
agentrinse purge --run <run-id>
agentrinse purge --run <run-id> --apply --yes
```

## commands

| Command                               | Purpose                                                   | Mutation              |
| ------------------------------------- | --------------------------------------------------------- | --------------------- |
| `agentrinse audit`                    | inventory a home and explain protection evidence          | none                  |
| `agentrinse plan`                     | create a bounded plan from a saved audit                  | persisted plan only   |
| `agentrinse clean --profile closeout` | audit and plan the current repository                     | none                  |
| `agentrinse apply --plan <file>`      | revalidate and apply an authorized plan                   | selected actions      |
| `agentrinse undo <run-id>`            | restore recoverable actions from a run                    | quarantine restore    |
| `agentrinse purge`                    | preview quarantined worktrees                             | none                  |
| `agentrinse purge --apply --yes`      | permanently remove selected quarantine entries            | destructive           |
| `agentrinse doctor`                   | diagnose platform, config, state, Git, and optional tools | none                  |
| `agentrinse adapters`                 | show adapter maturity and ownership                       | none                  |
| `agentrinse history`                  | list persisted cleanup runs                               | none                  |
| `agentrinse show`                     | inspect runs, plans, and resource findings                | none                  |
| `agentrinse lock status`              | inspect the global apply lock                             | none                  |
| `agentrinse lock recover --yes`       | remove a stale lock after process proof                   | stale lock only       |
| `agentrinse config`                   | locate, initialize, show, or validate configuration       | `init` creates a file |
| `agentrinse completion <shell>`       | generate bash, zsh, or fish completion                    | none                  |

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

agentrinse `0.3.0` never removes:

- provider sessions, transcripts, databases, credentials, or configuration
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

create a non-executable report for issue filing:

```bash
agentrinse audit --json --redact > audit-redacted.json
```

redaction replaces paths, salts identifiers per report, removes host fields,
and strips candidate actions. saved audit and plan evidence remains exact so
it can be verified before apply.

## platform support

| Platform       | `0.3.0` support                                               |
| -------------- | ------------------------------------------------------------- |
| macOS          | audit, artifact removal, worktree quarantine, undo, and purge |
| Linux          | audit, artifact removal, worktree quarantine, undo, and purge |
| WSL            | Linux contract inside the WSL filesystem                      |
| native Windows | audit-only; mutation remains blocked before `1.0.0`           |

Git and `lsof` are required for the complete diagnostic and process-ownership
contract. Docker is optional. Mole detection is available on macOS.

## docs

- [configuration](docs/configuration.md)
- [automation](docs/automation.md)
- [recovery](docs/recovery.md)
- [safety model](docs/safety.md)
- [adapter matrix](docs/adapters.md)
- [platform support](docs/platforms.md)
- [architecture](docs/architecture.md)
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

`0.3.0` ships the complete audit → plan → revalidate → apply loop, safe
configured artifact cleanup, and recoverable Git worktree
quarantine/undo/purge. Docker and provider-owned state remain report-only.

MIT licensed. built by [Vincent Koc](https://github.com/vincentkoc).
