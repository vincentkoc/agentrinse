# Architecture

AgentRinse separates evidence gathering from policy and mutation.

```text
CLI
  -> configuration
  -> adapter registry
  -> probes
  -> read-only collection
  -> protected findings
  -> deterministic dry-run plan
  -> explicit JSON output
```

## Current Components

### Contracts

Zod schemas define resources, diagnostics, findings, reports, and plans.
Boundary data is parsed before it leaves a command.

### Adapters

Provider adapters use declared data roots and known child resources. Git and
Docker use structured owner output. Every current adapter classifies resources
as protected.

### Audit Engine

The engine:

1. refuses unsafe roots
2. probes adapters independently
3. collects resources without following symlinks
4. classifies findings
5. validates the final report

### Plan Engine

The engine hashes canonical configuration and audit data, sets a bounded
expiry, and emits a content-addressed plan. Current plans have zero actions.

### State

Output is written only when the caller supplies an explicit path. JSON writes
use a same-directory temporary file, fsync, atomic rename, and owner-only
permissions.

## Future Mutation Boundary

Executors, locks, revalidation, quarantine, journals, and undo do not exist
yet. They must land before the first cleanup action and remain separate from
collectors.
