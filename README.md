# AgentRinse

Safe, local-first cleanup for agentic development.

AgentRinse inventories agent state and developer residue, explains why each
resource is protected or eligible, creates content-addressed cleanup plans,
and applies only actions that still pass every safety check.

Version `0.3.0` adds recoverable quarantine for fully proven inactive linked
Git worktrees. Quarantine is opt-in at the `recoverable` risk ceiling, keeps a
tested undo path, and reports zero immediate disk reclaim until a separate
purge. Exact configured rebuildable artifacts remain the only `safe` action.
Provider state, runtimes, and Docker resources remain report-only.

## Install

Node.js 22 or newer is required.

```bash
npm install --global agentrinse
agentrinse --version
```

Homebrew:

```bash
brew install vincentkoc/tap/agentrinse
```

One-off use also works:

```bash
npx agentrinse@0.3.0 doctor
```

## Quickstart

Create a default configuration without overwriting an existing file:

```bash
agentrinse config init
agentrinse config path
```

Edit the generated JSON and add explicit artifact roots:

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

Run diagnostics before the first audit:

```bash
agentrinse config validate
agentrinse doctor
```

Audit and save exact evidence:

```bash
agentrinse audit --home "$HOME" --output audit.json
```

Create and review a bounded plan:

```bash
agentrinse plan --audit audit.json --output plan.json
cat plan.json
```

Apply only after reviewing the plan:

```bash
agentrinse apply --plan plan.json
```

Interactive apply asks for confirmation. Automation must pass `--yes`.

## Agent Closeout

From a Git worktree, create a repository-scoped audit and plan:

```bash
agentrinse clean --profile closeout
```

The current worktree is always protected. The profile inventories its
repository's linked worktrees, loads Codex and Claude reachability metadata,
and ignores unrelated configured artifact projects. It does not infer that a
task is finished.

After reviewing the summary, a fresh closeout can apply existing `safe`
artifact actions:

```bash
agentrinse clean --profile closeout --apply
agentrinse clean --profile closeout --apply --yes --max-risk safe --json
```

Whole-worktree quarantine must be selected explicitly:

```bash
agentrinse clean --profile closeout --max-risk recoverable
agentrinse clean --profile closeout --max-risk recoverable --apply --yes
```

Quarantine moves bytes out of the active path but does not reclaim disk.
Restore or permanently purge the resulting run:

```bash
agentrinse undo <run-id>
agentrinse purge --run <run-id>
agentrinse purge --run <run-id> --apply --yes
```

On macOS, an installed Mole binary adds external `mo purge --dry-run` and
`mo clean --dry-run` suggestions. AgentRinse never runs those commands.

## Mutation Boundary

AgentRinse has two mutation classes.

`safe` artifact removal supports only these configured names:

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

Before removal it revalidates configured scope, canonical paths, device and
inode identity, recursive metadata fingerprint, measured bytes, newest
descendant age, mount boundaries, current working directory ownership,
same-user processes, and plan expiration. The exact target is atomically moved
to a same-parent tombstone and verified again before deletion.

`recoverable` worktree quarantine supports only linked, unlocked, clean,
pushed, branch-attached worktrees with complete measurement, no submodules,
no live process, no pin or provider root, and sufficient age. A recovery ref
is created before atomic same-filesystem rename. Git registration is repaired,
locked, verified, and recorded in an owner-only manifest.

AgentRinse never removes provider sessions, transcripts, databases,
credentials, configuration, plugins, skills, memories, Git branches, stashes,
Docker images, containers, networks, volumes, or build cache in `0.3.0`.

## Operations

```bash
agentrinse history
agentrinse show run <run-id>
agentrinse show plan <plan-id>
agentrinse show resource <resource-id>
agentrinse undo <run-id>
agentrinse purge
agentrinse purge --expired --apply --yes
agentrinse lock status
```

Opt into report-only selected runtime inventory:

```json
{
  "schemaVersion": 1,
  "adapters": {
    "runtime": { "enabled": true }
  }
}
```

A stale lock can be recovered only after AgentRinse proves the recorded local
process identity no longer exists:

```bash
agentrinse lock status
agentrinse lock recover --yes
```

Generate shell completion without modifying shell startup files:

```bash
agentrinse completion bash
agentrinse completion zsh
agentrinse completion fish
```

## Machine Output

`agentrinse audit --json` emits a versioned command envelope. Long audits can
emit incremental event records:

```bash
agentrinse audit --ndjson
```

Create a non-executable report for issue filing:

```bash
agentrinse audit --json --redact > audit-redacted.json
```

Redaction replaces paths, salts identifiers per report, removes host fields,
and strips candidate actions. Persisted state and `--output` evidence remain
exact so they can be used for planning.

## Platform Support

| Platform       | `0.3.0` support                                         |
| -------------- | ------------------------------------------------------- |
| macOS          | audit, artifact removal, worktree quarantine/undo/purge |
| Linux          | audit, artifact removal, worktree quarantine/undo/purge |
| WSL            | Linux contract inside the WSL filesystem                |
| native Windows | audit-only; mutation remains blocked before `1.0.0`     |

Git and `lsof` are required for the complete diagnostic and process-ownership
contract. Docker is optional. Doctor can detect the optional external Mole
tool on macOS.

## Documentation

- [Configuration](docs/configuration.md)
- [Automation](docs/automation.md)
- [Recovery](docs/recovery.md)
- [Platform support](docs/platforms.md)
- [Safety model](docs/safety.md)
- [Adapter matrix](docs/adapters.md)
- [Development](docs/development.md)
- [Releasing](docs/releasing.md)
- [Product specification](docs/product-spec.md)

## Development

```bash
pnpm install
pnpm check
pnpm smoke
pnpm pack:check
```

Tests and smoke runs use guarded temporary synthetic roots. Never point an
unreleased build at real developer state.

## License

MIT
