---
name: agentrinse
description: Inventory agent storage, Git object stores and worktrees with the installed AgentRinse CLI. Use for a read-only disk census, an explanation of cleanup coverage, or a review of a separately requested cleanup plan.
---

# AgentRinse

Check `agentrinse --version` and the selected command's `--help`. Ask for a repository parent or durable repository when the scope is unknown. Keep raw paths, configuration and native lifecycle reports private.

## Audit Git storage

Run `agentrinse git-inventory --repo-root "$REPOSITORY_PARENT" --redact --json`. The parent selects direct child owners, including hidden repositories and bare clones. Repeat `--repo-root` or name an individual owner with `--repo`. All native registrations of those owners matter, including missing checkouts and checkouts outside conventional worktree roots.

For many unpacked objects, add `--loose-objects`. It counts regular names against Git’s object format without opening object contents. For partial results, compare `fanoutsComplete` with `fanoutsObserved` to see how many directories stayed stable during their scan.

Use `--pack-headers` when temporary pack names dominate disk usage. Read the empty and header-only counts alongside unknown, withheld and budget-skipped counts. A short, partial or damaged file can contain the only surviving copy of object data. A recognized header proves only what occupies those first 12 bytes. Leave content validation and retained-copy proof to Git's owning repository.

Check the envelope status, per-owner coverage and entry budget first. A repository can retain verified counts while listing changed sections in `changedSections`. Retry those sections when the repository is quiet. Compare temporary filenames with unique inodes, mixed links and unobserved links. Allocated file blocks can share physical extents. A temporary name, lock, orphan-looking sidecar or Git-prunable registration supplies inventory evidence. Reclaimable bytes remain unknown.

When the checkout allocator supports it, stream its read-only inventory projection directly into the CLI using `gwt finish-status --all --read-only --inventory-json | agentrinse git-inventory --repo-root "$REPOSITORY_PARENT" --gwt-status-stdin`. Add `--worktree-root "$MANAGED_CONTAINER"` for a custom container. Legacy finish-status arrays establish reported signoff only. The native allocator must check current holders, protected history, recovery and retirement before a closeout.

## Grade selected linked checkouts

When a full Git audit times out, run `agentrinse worktree-grades --repo "$OWNER" --worktree "$CHECKOUT" --redact --json` on macOS or Linux. Use the canonical absolute owner and checkout paths. Repeat `--worktree` for up to 64 selections. Supply the same `--config` and provider home as the original audit. The report includes the full native registration count and one row per input in order. Check `graded`, `unknown` and each row's protection reasons. Retry smaller batches if the configured deadline expires. A grade is read-only evidence. It cannot authorize retirement or serve as input to a cleanup plan.

Use `config policy` for the installed policy catalog. For a 72-hour worktree preview, render a separate profile with `config render --set '/worktrees/minAgeMinutes=4320'` and pass the same file with `--config` to the preview and any separately authorized plan or apply. Use `storage.reviewAgeMinutes` for read-only cache screening.

## Pick the scope

For OpenClaw lane caches, run `agentrinse storage --family openclaw --measure --json --redact`. It covers Crabbox sync staging and both generations of PR dependency storage. Use the reported review age for the selected rule (48 hours by default). A live lane can hold an old donor. Use Crabbox's staging receipts and OpenClaw's native PR lifetime checks to verify current use before any separately authorized cleanup. Keep recent, held and unresolved entries.

- Use `worktrees --root "$CONTAINER"` for physical checkouts without a known owner registration. Read `unresolvedReason` to distinguish an observed empty group from one containing files or an incomplete inspection. Use `storage-rules` and `storage` for developer caches, staging areas and volume evidence.
- For a bounded provider audit, use `audit --no-state --quick --providers codex,claude --phase-timeout 5s --json --redact`. Quick scans skip size measurement.
- Use documented read-only provider and allocator commands for ownership and activity. Keep provider SQLite databases, their schemas and WAL files, and session transcripts out of ad hoc cleanup queries. If the owner cannot establish activity, keep the candidate protected.
- Keep a disk census read-only. For an explicitly requested cleanup, inspect a fresh scoped plan and its protection reasons. Use only the documented owner and recovery path for an authorized action. Native Windows supports audit only.
