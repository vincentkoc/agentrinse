# Automation

AgentRinse keeps human output and machine contracts separate. Scripts must
request JSON or NDJSON explicitly.

## Saved Evidence

`audit --output` and `plan --output` write exact schema-valid records:

```bash
agentrinse audit --home "$HOME" --output audit.json
agentrinse plan --audit audit.json --output plan.json
agentrinse apply --plan plan.json --yes --json
```

The saved audit is intentionally not wrapped because `plan` consumes it
directly. State records under the AgentRinse state directory use the same raw
schemas.

## Audit JSON

`audit --json` writes one command envelope to stdout:

```json
{
  "schemaVersion": 1,
  "command": "audit",
  "agentrinseVersion": "0.8.0",
  "startedAt": "2026-07-24T00:00:00.000Z",
  "completedAt": "2026-07-24T00:00:01.000Z",
  "status": "ok",
  "data": {},
  "diagnostics": []
}
```

The public JSON Schemas are shipped under `schemas/`, including command
envelopes, command events, audits, plans, runs, quarantine manifests, and
doctor reports.

## Audit NDJSON

`audit --ndjson` streams one compact JSON object per line. Every event has:

- `schemaVersion`
- `event`
- `timestamp`
- `command`
- `commandId`
- monotonic `sequence`
- optional `data`

The stream begins with `command.started`, includes adapter, resource, and
finding events as work completes, and ends with `command.completed`.

```bash
agentrinse audit --ndjson |
  jq -c 'select(.event == "finding.completed")'
```

Do not parse human output.

## Stateless Provider Audits

Headless checks can request only exact provider adapters and keep all evidence
on stdout:

```bash
agentrinse audit --providers cursor,copilot,opencode --no-state --json
agentrinse audit --providers cursor,copilot,opencode --no-state --ndjson
```

`--no-state` requires JSON or NDJSON and rejects `--output` and `--state-dir`
before config or provider discovery. It neither resolves nor creates the
AgentRinse state layout. `--providers` accepts a unique comma-separated list of
known provider IDs, overrides each selected provider's `enabled` setting, and
still honors its configured root when that root is absolute. Relative configured
roots are rejected before provider discovery. The selector is valid only with
`--no-state`. Transient provider reports omit every candidate action; if one is
manually redirected and passed to `plan`, it produces no cleanup actions.

Provider selection does not instantiate Git, Docker, runtime, or artifact
adapters even when configuration enables them. Node permission mode can deny
filesystem writes, child processes, and native addons. Node runtimes that do
not expose network and FFI permission controls still require OS containment:
use `sandbox-exec` on macOS or `bwrap` with seccomp on Linux and WSL. The
launcher owns that containment; AgentRinse does not weaken or emulate it.

## Redacted Reports

Redaction is available only with audit JSON or NDJSON:

```bash
agentrinse audit --json --redact > audit-redacted.json
agentrinse audit --ndjson --redact > audit-redacted.ndjson
```

Redaction:

- replaces the audit home with `$HOME`
- replaces other absolute paths with salted opaque tokens
- salts identifiers independently for each report
- removes host and hostname fields
- removes candidate actions
- preserves adapters, resource kinds, sizes, states, reason codes, and
  diagnostics

Redirect stdout to create a shareable report. `--output` and persisted state
remain exact and must not be attached to public issues.

## Non-Interactive Apply

Machine-readable apply requires explicit authorization:

```bash
agentrinse apply --plan plan.json --yes --json
```

Without `--yes`, a non-interactive apply is rejected. An expired or changed
resource is skipped rather than substituted.

## Exit Status

Current `0.8.0` behavior:

| Code  | Meaning                                      |
| ----- | -------------------------------------------- |
| `0`   | command completed                            |
| `1`   | command, arguments, config, or safety failed |
| `2`   | apply completed as failed or partial         |
| `130` | apply was interrupted at a safe checkpoint   |

The run journal remains the source of truth for apply outcomes.

A degraded `audit` remains report-only and exits `0`. A degraded `clean`
closeout exits `1` so automation does not treat incomplete safety evidence as
a clean closeout.

## Closeout Profile

The closeout profile starts from the current Git worktree, inventories every
worktree registered to that repository, loads only Codex and Claude
reachability metadata, and filters configured artifact projects to those
worktrees:

```bash
agentrinse clean --profile closeout
agentrinse clean --profile closeout --json
```

The current worktree is always a root. A dry run persists the exact audit,
plan, and derived scoped config. The printed config path can be supplied if
the persisted plan is applied separately:

```bash
agentrinse apply --plan <plan-path> --config <config-path> --yes
```

For a fresh one-command apply of existing `safe` artifact actions:

```bash
agentrinse clean --profile closeout --apply
agentrinse clean --profile closeout --apply --yes --max-risk safe --json
```

The profile does not infer that work is complete. Call it only after the task
has landed, been handed off, or otherwise reached a terminal state.

## Fleet Profile

Fleet cleanup requires every repository and the risk ceiling to be explicit:

```bash
agentrinse clean --profile fleet \
  --repo /path/to/repo-a \
  --repo /path/to/repo-b \
  --max-risk safe \
  --json
```

Use `recoverable` to select proven inactive worktree quarantine actions.
`destructive` and `experimental` are refused. Fleet mode does not infer a
repository from the current directory and does not crawl home. Every `--repo`
must be absolute. Main and linked paths for the same repository are
deduplicated by the physical Git common directory.

The fleet summary reports repository count, risk ceiling, candidate and
selected actions, exclusions by risk, candidates by risk, candidate and
selected quarantine bytes, unknown findings, the five most frequent blockers,
and diagnostics. `--apply --yes` uses the same persisted immutable plan,
global lock, journal, revalidation, and executors as `agentrinse apply`. If no
actions are selected, no apply lock or run journal is created.

Recoverable worktree selection must be explicit:

```bash
agentrinse clean --profile closeout --max-risk recoverable
agentrinse clean --profile closeout --max-risk recoverable --apply --yes --json
```

Machine output separates `reclaimedBytes` from `quarantinedBytes`. A
quarantined worktree has zero immediate reclaim until a separate purge.

Undo and purge machine modes also require explicit authorization:

```bash
agentrinse undo <run-id> --yes --json
agentrinse purge --expired --apply --yes --json
agentrinse purge --run <run-id> --apply --yes --json
```

On macOS, an installed Mole binary adds two external suggestions:
`mo purge --dry-run` and `mo clean --dry-run`. AgentRinse does not execute or
parse either command.
