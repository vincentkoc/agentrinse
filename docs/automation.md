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
  "agentrinseVersion": "0.2.0",
  "startedAt": "2026-07-24T00:00:00.000Z",
  "completedAt": "2026-07-24T00:00:01.000Z",
  "status": "ok",
  "data": {},
  "diagnostics": []
}
```

The public JSON Schemas are shipped under `schemas/`, including command
envelopes, command events, audits, plans, runs, and doctor reports.

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

Current `0.2.0` behavior:

| Code  | Meaning                                      |
| ----- | -------------------------------------------- |
| `0`   | command completed                            |
| `1`   | command, arguments, config, or safety failed |
| `2`   | apply completed as failed or partial         |
| `130` | apply was interrupted at a safe checkpoint   |

The run journal remains the source of truth for apply outcomes.

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

On macOS, an installed Mole binary adds two external suggestions:
`mo purge --dry-run` and `mo clean --dry-run`. AgentRinse does not execute or
parse either command.
