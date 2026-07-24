# Platform Support

AgentRinse separates read-only inventory from mutation capability. A platform
can audit successfully while apply remains unavailable or blocked by missing
ownership proof.

## Requirements

- Node.js 22 or newer
- Git
- `lsof`
- `lockf` on macOS or `flock` from `util-linux` on Linux
- local filesystem state directory with owner read/write access

Docker is optional and isolated to its adapter. Mole is an optional external
macOS handoff.

Run `agentrinse doctor` to verify the current machine without mutating it.

## macOS

macOS is Tier 1 for `0.1.0`.

- provider, Git, Docker, and configured artifact inventory
- `lsof` process ownership proof
- safe configured artifact apply
- optional Mole detection through `mo --version`
- external `mo purge --dry-run` and `mo clean --dry-run` suggestions from the
  closeout profile

Mole remains external. AgentRinse does not embed, invoke, or parse Mole
cleanup.

## Linux

Linux is Tier 2 for `0.1.0`.

- provider, Git, Docker, and configured artifact inventory
- same-user `/proc` process ownership inspection
- `lsof` fallback when procfs is incomplete or restricted
- safe configured artifact apply

If neither `/proc` nor `lsof` can prove a target idle, apply skips it.

Stale-lock recovery uses the kernel-held `lockf` utility on macOS and `flock`
from `util-linux` on Linux. A crashed recovery process releases the mutex
automatically.

## WSL

WSL follows the Linux contract for paths and processes inside the WSL
filesystem. Do not use `0.1.0` to mutate Windows-mounted project trees unless
doctor and a disposable canary prove path identity, ownership, rename, and
mount behavior for that exact setup.

## Native Windows

Native Windows is audit-only before `1.0.0`.

Process start identity, descriptor ownership, path semantics, and atomic
isolation have not reached the mutation proof bar. Doctor reports this
limitation and recommends WSL for supported artifact apply.

## Docker Isolation

When enabled, Docker uses the current CLI context and structured output.
Unavailable CLI, context, or daemon state degrades only Docker inventory.
`0.1.0` does not remove any Docker resource.
