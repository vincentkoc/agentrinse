# Changelog

All notable changes to AgentRinse will be documented in this file.

The project follows semantic versioning after its first supported release.

## [Unreleased]

## [0.2.0] - 2026-07-24

### Added

- path, resource-id, and Git-ref pins with optional expiry
- Codex and Claude workspace roots derived from metadata without reading
  transcript bodies
- repository-scoped `clean --profile closeout` with persisted audit, plan,
  exact derived config, optional safe apply, compact JSON, and external Mole
  dry-run suggestions
- opt-in report-only inventory for selected agent executables and Claude
  native installed versions

### Safety

- malformed or unreadable provider metadata protects all affected Git
  worktrees instead of being treated as empty
- worktree and session roots suppress nested artifact actions

## [0.1.0] - 2026-07-24

### Added

- TypeScript npm package and `agentrinse` CLI
- MIT license and repository safety policy
- versioned audit, finding, resource, diagnostic, plan, action, and run
  contracts
- symlink-safe size measurement
- report-only adapters for Codex, Claude, Cursor, GitHub Copilot, Zed,
  OpenCode, and Grok Build
- opt-in report-only Git worktree and Docker adapters
- explicit rebuildable artifact discovery for configured project roots
- content-addressed cleanup plans with bounded authorization windows
- locked apply runs with immediate identity, size, path, and process
  revalidation
- same-parent atomic isolation before recursive artifact removal
- durable per-action run journals and partial-apply recovery paths
- versioned JSON Schemas
- packaged audit, plan, and apply smoke test
- configuration initialization and validation
- environment doctor, run history, record inspection, and owned stale-lock
  recovery
- versioned JSON envelopes, NDJSON audit events, and non-executable redacted
  audit output
- bash, zsh, and fish completion generation
- cooperative SIGINT handling with durable interrupted-run journals
- runtime guards for every destructive synthetic fixture

### Safety

- provider state, Git worktrees, Docker resources, branches, stashes,
  credentials, plugins, skills, memories, and Docker volumes remain
  report-only
- only exact configured rebuildable artifact directories can be removed
- unknown process ownership, symlinks, path drift, inode drift, size drift,
  expired plans, changed configuration, and concurrent runs fail closed
- no process killing, `sudo`, generic force flag, wildcard deletion, or
  unfiltered Docker prune

## [0.0.0] - 2026-07-24

### Added

- reserved the public `agentrinse` npm package name
- linked the package to the public source repository
- documented that the reservation release is unsupported for operational
  cleanup
