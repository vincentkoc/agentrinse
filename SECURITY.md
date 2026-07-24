# Security Policy

## Reporting

Do not open a public issue for a vulnerability that could cause unintended
file deletion, transcript exposure, credential exposure, path traversal, or
command execution.

Report security issues privately through GitHub's private vulnerability
reporting for this repository.

## Scope

High-impact classes include:

- cleanup escaping its planned root
- symlink or time-of-check/time-of-use path swaps
- deletion of protected user or agent state
- command injection through paths or metadata
- plan tampering
- sensitive data in reports or journals
- provider database mutation while the owner is active

## Current Status

The implemented cleanup boundary can remove only exact configured rebuildable
artifact directories through a content-addressed, locked, revalidated, and
journaled apply path.
Provider state, Git worktrees, and Docker resources remain report-only.

Reports involving unintended removal, path or symlink escape, plan bypass,
lock ownership, incomplete journaling, or missing recovery paths are
security-sensitive.
