---
name: agentrinse
description: Inventory agent storage, Git object stores and worktrees with the installed AgentRinse CLI. Use for a read-only disk census, an explanation of cleanup coverage, or a review of a separately requested cleanup plan.
---

# AgentRinse

Check `agentrinse --version` and the selected command's `--help`. Ask for a repository parent or durable repository when the scope is unknown. Keep raw paths, configuration and native lifecycle reports private.

## Audit Git storage

Run `agentrinse git-inventory --repo-root "$REPOSITORY_PARENT" --redact --json`. The parent selects direct child owners, including hidden repositories and bare clones. Repeat `--repo-root` or name an individual owner with `--repo`. All native registrations of those owners matter, including missing checkouts and checkouts outside conventional worktree roots.

For many unpacked objects, add `--loose-objects`. It counts regular names against Git’s object format without opening object contents.

Check the envelope status, per-owner coverage and entry budget first. A repository can retain verified counts while listing changed sections in `changedSections`. Retry those sections when the repository is quiet. Compare temporary filenames with unique inodes, mixed links and unobserved links. Allocated file blocks can share physical extents. A temporary name, lock, orphan-looking sidecar or Git-prunable registration supplies inventory evidence. Reclaimable bytes remain unknown.

When the checkout allocator supports it, stream its read-only inventory projection directly into the CLI using `gwt finish-status --all --read-only --inventory-json | agentrinse git-inventory --repo-root "$REPOSITORY_PARENT" --gwt-status-stdin`. Add `--worktree-root "$MANAGED_CONTAINER"` for a custom container. Legacy finish-status arrays establish reported signoff only. The native allocator must check current holders, protected history, recovery and retirement before a closeout.

## Pick the scope

- Use `worktrees --root "$CONTAINER"` for physical checkouts without a known owner registration. Use `storage-rules` and `storage` for developer caches, staging areas and volume evidence.
- For a bounded provider audit, use `audit --no-state --quick --providers codex,claude --phase-timeout 5s --json --redact`. Quick scans skip size measurement.
- Keep a disk census read-only. For an explicitly requested cleanup, inspect a fresh scoped plan and its protection reasons. Use only the documented owner and recovery path for an authorized action. Native Windows supports audit only.
