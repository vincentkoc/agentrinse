# Safety Model

AgentRinse is designed around refusal. A resource becomes cleanable only after
its owner, reachability, activity, and recovery behavior are positively known.

## Current Release Boundary

Version `0.0.0` is audit-only:

- `audit` reads an explicitly supplied synthetic home
- `plan` consumes a saved audit
- every provider resource is protected
- every generated plan contains zero actions
- there is no `apply` command

The CLI refuses the real home directory and `/`.

## Hard Invariants

- Unknown state is protected.
- Discovery and planning never clean.
- Provider session stores are report-only.
- Symlinks are not followed.
- Git worktrees remain protected until dirty, process, session, lock, and push
  state can all be proved.
- No process is killed.
- No credentials, configuration, plugins, skills, memories, branches, stashes,
  or Docker volumes are deleted.
- No project configuration is executed as code.
- No generic force flag exists.

## Future Mutation Gate

A mutating action is not ready until it has:

1. a stable resource identity
2. explicit protection roots
3. versioned policy
4. a persisted plan
5. immediate revalidation
6. a bounded owner operation
7. a durable run journal
8. postcondition verification
9. recovery or an explicit destructive classification
10. interruption and race tests

No adapter may bypass this gate.

