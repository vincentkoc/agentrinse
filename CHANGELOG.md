# Changelog

All notable changes to AgentRinse will be documented in this file.

The project follows semantic versioning after its first published release.

## Unreleased

### Added

- private TypeScript npm package scaffold
- MIT license and repository safety policy
- versioned audit, finding, resource, diagnostic, and plan contracts
- synthetic-home safety guard
- symlink-safe size measurement
- report-only adapters for Codex, Claude, Cursor, GitHub Copilot, Zed,
  OpenCode, and Grok Build
- opt-in report-only Git worktree and Docker adapters
- deterministic zero-action cleanup plans
- atomic explicit JSON output
- synthetic smoke test and GitHub Actions CI

### Safety

- pre-alpha builds refuse the real home directory and `/`
- provider state remains protected
- no cleanup or apply command exists
