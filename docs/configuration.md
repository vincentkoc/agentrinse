# Configuration

AgentRinse is safe by default: provider adapters inventory state, while
artifact cleanup remains disabled until project roots are explicitly listed.
Codex database compaction additionally requires an audit opt-in and the
`experimental` risk ceiling.

## Resolution

Configuration is resolved in this order:

1. `--config <path>`
2. `$XDG_CONFIG_HOME/agentrinse/config.json`
3. `$HOME/.config/agentrinse/config.json`

Use the CLI to inspect or initialize the selected path:

```bash
agentrinse config path
agentrinse config init
agentrinse config show
agentrinse config validate
```

`config init` uses an exclusive create and never overwrites an existing file.
If the default path does not exist, audit uses safe built-in defaults.
An explicitly requested missing or invalid file is an error.

## Schema

```json
{
  "schemaVersion": 1,
  "adapters": {
    "codex": { "enabled": true },
    "claude": { "enabled": true },
    "cursor": { "enabled": true },
    "copilot": { "enabled": true },
    "zed": { "enabled": true },
    "opencode": { "enabled": true },
    "grok": { "enabled": true },
    "runtime": { "enabled": false },
    "git": { "enabled": false, "root": "/absolute/repository" },
    "docker": { "enabled": false }
  },
  "audit": {
    "maxEntries": 100000,
    "measureBytes": true
  },
  "artifacts": {
    "projects": [
      {
        "root": "/absolute/project",
        "names": ["node_modules", "dist"]
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
  "pins": [
    { "path": "/absolute/project-worktree" },
    { "resourceId": "git:git-worktree:..." },
    {
      "gitRef": "refs/heads/release",
      "expiresAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "plan": {
    "ttlMinutes": 30,
    "maxRisk": "safe"
  }
}
```

Unknown keys are discarded by the current schema. Project roots must be
unique absolute paths. Cleanup targets from different project entries may not
overlap.

## Pins

Pins are explicit user-owned protection roots. A pin may name one absolute
path, one exact AgentRinse resource ID, or one full Git ref under
`refs/heads`, `refs/remotes`, or `refs/tags`.

`expiresAt` is optional and must be an ISO 8601 timestamp. An expired pin is
ignored. Pin evidence is hashed in findings; AgentRinse does not emit the
configured path or ref as the evidence reference.

Git ref pins resolve through the Git adapter before artifact classification.
If Git is disabled or ref inspection is incomplete, AgentRinse conservatively
protects the unresolved scope instead of allowing an artifact action.

## Provider Adapters

Codex, Claude Code, Cursor, GitHub Copilot CLI, Zed, OpenCode, and Grok Build
are enabled for read-only inventory by default. Each accepts an optional
`root`. Claude resolves its root from the explicit adapter `root`, then an
absolute `$CLAUDE_CONFIG_DIR`, then `$HOME/.claude`. A relative
`$CLAUDE_CONFIG_DIR` degrades the Claude adapter rather than auditing the wrong
directory. The same resolution is repeated before any provider-file action is
authorized. Missing default roots mean the provider is absent, not broken.
Codex can propose offline database maintenance only with
`audit --allow-offline-vacuum`; the flag is intentionally not persisted in
configuration. A
missing explicit root is a doctor warning.

Git is disabled by default and requires an explicit repository root. When
enabled, eligible linked worktrees may produce `recoverable` quarantine
actions; the default `safe` plan ceiling excludes them. Runtime
inventory is disabled by default because it searches `PATH` and may execute
selected binaries with `--version`. Docker is disabled by default and uses
the active Docker context when enabled. Runtime and Docker remain report-only.

## Worktree Quarantine

`worktrees.minAgeMinutes` defaults to 14 days and is measured from the newest
entry in the complete worktree scan. `worktrees.quarantineTtlMinutes` defaults
to 7 days and may not exceed 30 days.

Quarantine is never selected unless `plan.maxRisk` or a command-specific
`--max-risk` is `recoverable` or higher. It retains all bytes until explicit
purge.

## Artifact Projects

The supported names are:

```text
node_modules  dist  dist-runtime  build  .next  .turbo
.cache        coverage  target    .venv
```

Names are fixed enums, not patterns. AgentRinse does not crawl for projects,
expand globs, or run rebuild commands.

An artifact becomes eligible only when:

- its project root and target are canonical real directories inside the audit
  home
- the complete tree fits within `audit.maxEntries`
- no unsupported special entries or mount boundaries exist
- measured bytes meet `artifacts.minBytes`
- the newest descendant age meets `artifacts.minAgeMinutes`
- same-user process ownership is proven idle

Apply repeats every check under the exclusive lock.

## State

State is resolved in this order:

1. `--state-dir <path>`
2. `$XDG_STATE_HOME/agentrinse`
3. `$HOME/.local/state/agentrinse`

The state root stores exact audits, plans, run journals, quarantine manifests,
and the apply lock. Do not place it inside a configured cleanup target.
