# Configuration

AgentRinse is safe by default: provider adapters inventory state, while
artifact cleanup remains disabled until project roots are explicitly listed.

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
  "plan": {
    "ttlMinutes": 30,
    "maxRisk": "safe"
  }
}
```

Unknown keys are discarded by the current schema. Project roots must be
unique absolute paths. Cleanup targets from different project entries may not
overlap.

## Provider Adapters

Codex, Claude Code, Cursor, GitHub Copilot CLI, Zed, OpenCode, and Grok Build
are enabled for read-only inventory by default. Each accepts an optional
`root`. Missing default roots mean the provider is absent, not broken. A
missing explicit root is a doctor warning.

Git is disabled by default and requires an explicit repository root. Docker is
disabled by default and uses the active Docker context when enabled. Both
adapters remain report-only in `0.1.0`.

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

The state root stores exact audits, plans, run journals, and the apply lock.
Do not place it inside a configured cleanup target.
