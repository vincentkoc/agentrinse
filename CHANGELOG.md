# Changelog

All notable changes to AgentRinse will be documented in this file.

The project follows semantic versioning after its first published release.

## [0.1.0] - 2026-07-23

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

### Safety

- provider state, Git worktrees, Docker resources, branches, stashes,
  credentials, plugins, skills, memories, and Docker volumes remain
  report-only
- only exact configured rebuildable artifact directories can be removed
- unknown process ownership, symlinks, path drift, inode drift, size drift,
  expired plans, changed configuration, and concurrent runs fail closed
- no process killing, `sudo`, generic force flag, wildcard deletion, or
  unfiltered Docker prune
