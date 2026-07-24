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

Quarantine manifests live beside them under:

```text
$XDG_STATE_HOME/agentrinse/quarantine/<entry-id>.json
```

They record both the planned worktree identity and its post-repair quarantine
identity.

## Restore a Quarantined Worktree

Inspect the run first:

```bash
agentrinse show run <run-id>
agentrinse undo <run-id>
agentrinse undo <run-id> --action <action-id>
```

Undo prompts before mutation; automation must use `--yes`. It refuses to
overwrite a recreated original path. It also refuses changed content, tracked,
untracked, ignored, or status-suppressed Git state, a live process, a mount
boundary, a changed registration, or a recovery ref that no longer points to
the recorded HEAD.

Successful undo:

1. unlocks the quarantined Git worktree
2. atomically renames it to the original path
3. repairs and verifies the Git registration
4. verifies the exact HEAD, branch, complete clean status, process state, and
   mount state
5. deletes only the recorded recovery ref
6. persists the manifest as `restored`

Undo also recovers interrupted initial quarantine states. If the original path
still exists, it verifies that path, removes only the exact recovery ref when
present, and records `restored`. If the atomic move already happened, it
repairs and validates the quarantine path, recreates only the exact namespaced
recovery ref when missing, relocks the worktree, then completes normal undo.
Every recovery mutation requires either an unlocked registration at the
expected transition or the exact `AgentRinse quarantine <entry-id>` lock.
AgentRinse never unlocks a worktree carrying an operator or third-party lock.
That lock check happens before `git worktree repair`, including interrupted
move and purge-isolation recovery. The matching registration must still be at
the exact old or new path for that transition; a third path is refused.
Merge, rebase, cherry-pick, revert, and bisect markers are rechecked from the
worktree's Git administration directory immediately before mutation.

## Purge Quarantine

Preview is the default:

```bash
agentrinse purge
agentrinse purge --expired
agentrinse purge --run <run-id>
```

Destructive purge requires an explicit selection and apply:

```bash
agentrinse purge --expired --apply --yes
agentrinse purge --run <run-id> --apply --yes
```

`--expired` respects the manifest TTL. `--run` is an explicit operator choice
and can purge before expiry. Purge revalidates the unchanged clean worktree,
conditionally releases its owned lock, atomically renames it to a deterministic
same-filesystem isolation path, repairs and revalidates the Git registration
there, invokes `git worktree remove` without `--force`, verifies path and
registration removal, then deletes the exact recovery ref.

Immediately before each destructive purge, AgentRinse reloads configuration
and provider workspace metadata while holding the mutation lock. It checks the
recorded resource ID and Git ref plus both the original and quarantine paths.
Current pins, provider-managed roots, active or recent sessions, and unknown
provider state all refuse permanent removal.

If AgentRinse restarts while the worktree is at the purge isolation path, it
repeats full validation there. A failed validation moves the worktree back to
the quarantine path, repairs and relocks it with the exact AgentRinse lock
reason, and records the entry as retryable instead of leaving it isolated.
If both deterministic paths are absent, purge finalization also refuses any
registration at another path with the recorded branch and HEAD.
The same relocated-registration check runs after a normal purge removal before
the recovery ref or manifest can be finalized.

The root `.git` control file is excluded from worktree content fingerprints
because `git worktree repair` owns and rewrites it. Ignored files and every
other worktree entry remain inside the fingerprint and refusal boundary.

AgentRinse does not use `git worktree unlock` for recovery mutations because
that command removes whichever lock exists at execution time. Instead it
atomically moves the administrative `locked` file to an AgentRinse claim,
verifies the captured reason, and restores the file if ownership changed. A
verified release becomes a tiny `locked.agentrinse-released-*` proof marker in
the linked-worktree administrative directory. Git ignores the marker and
removes it with that worktree's administrative directory. A deterministic
in-progress claim is restored before later validation after interruption.

Atomic quarantine itself does not free disk. Only purge reports those bytes as
reclaimed.

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

Recovery is serialized by a kernel-held mutex (`lockf` on macOS, `flock` on
Linux). A crashed recovery process releases that mutex automatically; the
marker file itself is not evidence that recovery is active.

## State Corruption

Run:

```bash
agentrinse doctor
```

Doctor validates persisted audit, plan, run, and quarantine schemas without
rewriting them. Preserve incompatible files before moving them out of the
state directory. Never delete a journal or quarantine manifest that is the
only record of a partial action.

For a `partial` quarantine entry, do not run Git prune or delete the recovery
ref. Inspect the manifest paths and current `git worktree list --porcelain`
output first. Preserve the ref until either the original or quarantined path is
verified at the recorded HEAD.
