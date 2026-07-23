# AgentRinse

Safe, local-first cleanup for agentic development.

AgentRinse inventories agent state and developer residue, explains why
resources are protected, produces content-addressed cleanup plans, and applies
only actions that still pass every safety check.

## Version 0.1

The first production mutation boundary is intentionally narrow:

- removes only exact rebuildable artifact directories declared in config
- supports `node_modules`, `dist`, `dist-runtime`, `build`, `.next`, `.turbo`,
  `.cache`, `coverage`, `target`, and `.venv`
- revalidates path, realpath, inode, device, recursive metadata fingerprint,
  newest descendant mtime, measured bytes, configured scope, current working
  directory, and process ownership after acquiring the apply lock
- rejects artifact roots and descendants that cross filesystem mount
  boundaries
- atomically renames an artifact to a same-parent tombstone before recursive
  removal, then repeats fingerprint and process checks on the isolated tree
- journals every transition and records the recovery path for partial actions

Codex, Claude Code, Cursor, GitHub Copilot CLI, Zed, OpenCode, Grok Build, Git,
and Docker are report-only. Provider state, worktrees, images, containers,
volumes, branches, stashes, credentials, configuration, plugins, skills, and
memories are never removed by version 0.1.

## Install

```bash
npm install --global agentrinse
agentrinse --version
```

Node.js 22 or newer is required.

## Configure

Artifact cleanup is disabled until project roots are explicitly declared.

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
  "plan": {
    "ttlMinutes": 30,
    "maxRisk": "safe"
  }
}
```

Project roots must be unique absolute real directories inside the audited
home. Artifact targets cannot overlap. AgentRinse never discovers arbitrary
projects or expands wildcards.

## Use

Audit and save immutable evidence:

```bash
agentrinse audit \
  --home "$HOME" \
  --config agentrinse.json \
  --json \
  --output audit.json
```

Create a bounded cleanup plan:

```bash
agentrinse plan \
  --audit audit.json \
  --config agentrinse.json \
  --output plan.json
```

Review `plan.json`, then apply it:

```bash
agentrinse apply \
  --plan plan.json \
  --config agentrinse.json \
  --yes
```

Without `--yes`, apply requires an interactive terminal confirmation. A plan
is rejected when it expires, changes, no longer matches the config, or contains
inconsistent action totals. Changed resources are recorded as
`skipped-stale`, not deleted.

Run journals are stored under `$XDG_STATE_HOME/agentrinse/runs` or
`$HOME/.local/state/agentrinse/runs`. Use `--state-dir` to select another
location.

## Safety

- discovery and planning never mutate
- unknown state is protected
- symlinks are not followed
- no process is killed
- no `sudo`
- no Docker volume deletion
- no generic `--force`
- no wildcard deletion
- one apply run holds the exclusive state lock
- AgentRinse never removes its own working directory, lock, or journal

See `docs/safety.md` for the complete mutation contract.

## Development

```bash
pnpm install
pnpm check
pnpm smoke
pnpm pack:check
```

Development, tests, smoke runs, and destructive proof use temporary synthetic
homes only. Never point an unreleased development build at a workstation home.

## License

MIT
