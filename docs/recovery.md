# Recovery

AgentRinse records enough local state to distinguish completed, skipped,
failed, partial, and interrupted runs. It does not retry an old plan
automatically.

## Inspect Runs

```bash
agentrinse history
agentrinse history --since 30d
agentrinse show run <run-id>
```

Run journals live under:

```text
$XDG_STATE_HOME/agentrinse/runs/<run-id>.json
```

or `$HOME/.local/state/agentrinse/runs` when `XDG_STATE_HOME` is unset.

## Interrupted Runs

The first SIGINT requests cooperative cancellation. AgentRinse finishes any
active isolation/removal critical section, persists its exact outcome, then
marks the run `interrupted` at the next safe checkpoint. Repeated SIGINT does
not bypass journaling.

Inspect the run. Do not reuse its plan. Create a fresh audit and plan after
confirming every recorded path.

## Partial or Failed Runs

`show run` prints each diagnostic and last known isolation path. A tombstone
has the form:

```text
<project>/.agentrinse-<run-and-action-id>.tombstone
```

If a run is `partial`, some content may already be gone. Do not assume the
original or tombstone tree is complete. Inspect both paths, preserve needed
files, repair the project with its normal package/build tool, then create a
fresh audit.

AgentRinse never labels a removal failure as rolled back after recursive
deletion has begun.

## Apply Locks

Inspect before recovery:

```bash
agentrinse lock status
agentrinse lock status --json
```

The lock records PID, process start identity where available, hostname,
command, plan ID, run ID, token, and creation time.

Recovery is allowed only when:

- the lock hostname matches the current host
- the recorded process is absent, or the PID belongs to a process with a
  different start identity
- the lock token and inode still match immediately before removal

Age alone is never proof.

```bash
agentrinse lock recover --yes
```

Remote, active, malformed, or uninspectable locks fail closed.

## State Corruption

Run:

```bash
agentrinse doctor
```

Doctor validates persisted audit, plan, and run schemas without rewriting
them. Preserve incompatible files before moving them out of the state
directory. Never delete a journal that is the only record of a partial action.
