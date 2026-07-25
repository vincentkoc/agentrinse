import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { CleanupPlan } from "../../src/contracts/plan.js";
import { readJsonFile } from "../../src/state/json-file.js";
import { createRunJournal } from "../../src/state/run-journal.js";

const PLAN: CleanupPlan = {
  schemaVersion: 1,
  planId: "plan-1",
  auditId: "audit-1",
  home: "/tmp/fixture",
  createdAt: "2026-07-23T00:00:00.000Z",
  expiresAt: "2026-07-23T01:00:00.000Z",
  policyVersion: 1,
  riskCeiling: "safe",
  configDigest: "config",
  auditDigest: "audit",
  actions: [
    {
      actionId: "action-1",
      type: "artifacts.remove",
      adapter: "artifacts",
      resourceId: "resource-1",
      risk: "safe",
      description: "remove fixture",
      expectedReclaimBytes: 10,
      target: {
        path: "/tmp/fixture/node_modules",
        projectRoot: "/tmp/fixture",
        name: "node_modules",
        device: 1,
        inode: 2,
        mtimeMs: 3,
        measuredBytes: 10,
        newestMtimeMs: 4,
        fingerprint: "a".repeat(64),
      },
    },
  ],
  expectedReclaimBytes: 10,
};

describe("run journal", () => {
  it("persists every action transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-run-"));
    const journal = await createRunJournal(
      root,
      PLAN,
      new Date("2026-07-23T00:00:00.000Z"),
      "run-1",
    );

    await journal.updateAction("action-1", {
      status: "applied",
      startedAt: "2026-07-23T00:00:01.000Z",
      completedAt: "2026-07-23T00:00:02.000Z",
      reclaimedBytes: 10,
    });
    const completed = await journal.complete(new Date("2026-07-23T00:00:03.000Z"));

    expect(completed.status).toBe("completed");
    expect(completed.runId).toBe("run-1");
    expect(completed.reclaimedBytes).toBe(10);
    expect(await readJsonFile(journal.path)).toEqual(completed);
  });

  it("marks a run partial when applied and failed actions coexist", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-run-"));
    const plan: CleanupPlan = {
      ...PLAN,
      actions: [
        PLAN.actions[0]!,
        {
          ...PLAN.actions[0]!,
          actionId: "action-2",
          resourceId: "resource-2",
        },
      ],
    };
    const journal = await createRunJournal(root, plan);
    await journal.updateAction("action-1", {
      status: "applied",
      reclaimedBytes: 10,
    });
    await journal.updateAction("action-2", { status: "failed" });

    expect((await journal.complete()).status).toBe("partial");
  });

  it("treats a rolled-back action as a failed run", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-run-"));
    const journal = await createRunJournal(root, PLAN);
    await journal.updateAction("action-1", {
      status: "rolled-back",
      isolationPath: "/tmp/fixture/.agentrinse-tombstone",
    });

    expect((await journal.complete()).status).toBe("failed");
  });

  it("persists an interrupted run without rewriting action truth", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-run-"));
    const journal = await createRunJournal(root, PLAN);
    await journal.updateAction("action-1", {
      status: "applying",
      isolationPath: "/tmp/fixture/.agentrinse-tombstone",
    });

    const interrupted = await journal.interrupt(
      {
        severity: "warning",
        code: "COMMAND_INTERRUPTED",
        message: "fixture interrupted",
      },
      new Date("2026-07-23T00:00:03.000Z"),
    );

    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.actions[0]?.status).toBe("applying");
    expect(interrupted.reclaimedBytes).toBe(
      interrupted.actions.reduce((total, action) => total + (action.reclaimedBytes ?? 0), 0),
    );
    expect(interrupted.diagnostics[0]?.code).toBe("COMMAND_INTERRUPTED");
    expect(await readJsonFile(journal.path)).toEqual(interrupted);
  });

  it("tracks quarantined bytes without claiming immediate reclaim", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-run-"));
    const plan: CleanupPlan = {
      ...PLAN,
      riskCeiling: "recoverable",
      actions: [
        {
          actionId: "action-worktree",
          type: "worktree.quarantine",
          adapter: "git",
          resourceId: "git:git-worktree:fixture",
          risk: "recoverable",
          description: "quarantine fixture",
          expectedReclaimBytes: 0,
          pendingQuarantineBytes: 20,
          quarantineTtlMinutes: 60,
          target: {
            path: "/tmp/fixture-worktree",
            repositoryCommonDir: "/tmp/repo/.git",
            head: "a".repeat(40),
            branch: "refs/heads/feature",
            device: 1,
            inode: 2,
            mtimeMs: 3,
            measuredBytes: 20,
            newestMtimeMs: 4,
            fingerprint: "b".repeat(64),
          },
        },
      ],
      expectedReclaimBytes: 0,
      pendingQuarantineBytes: 20,
    };
    const journal = await createRunJournal(root, plan);

    await journal.updateAction("action-worktree", {
      status: "applied",
      quarantinedBytes: 20,
      quarantineEntryId: "entry-1",
      quarantinePath: "/tmp/.agentrinse-quarantine/entry-1",
      recoveryRef: "refs/agentrinse/quarantine/run/action",
    });
    const completed = await journal.complete();

    expect(completed.reclaimedBytes).toBe(0);
    expect(completed.quarantinedBytes).toBe(20);
  });

  it("tracks provider-file quarantine bytes without claiming reclaim", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-run-"));
    const plan: CleanupPlan = {
      ...PLAN,
      riskCeiling: "recoverable",
      actions: [
        {
          actionId: "action-provider-file",
          type: "provider.file-quarantine",
          adapter: "claude",
          resourceId: "claude:agent-log:fixture",
          policyId: "claude.debug-log",
          risk: "recoverable",
          description: "archive fixture provider log",
          expectedReclaimBytes: 0,
          pendingQuarantineBytes: 20,
          quarantineTtlMinutes: 60,
          target: {
            path: "/tmp/fixture/.claude/debug/session.txt",
            ownerRoot: "/tmp/fixture/.claude",
            relativePath: "debug/session.txt",
            provider: "claude",
            device: 1,
            inode: 2,
            mode: 0o100600,
            mtimeMs: 3,
            measuredBytes: 20,
            contentSha256: "a".repeat(64),
            fingerprint: "b".repeat(64),
          },
        },
      ],
      expectedReclaimBytes: 0,
      pendingQuarantineBytes: 20,
    };
    const journal = await createRunJournal(root, plan);

    await journal.updateAction("action-provider-file", {
      status: "applied",
      quarantinedBytes: 20,
      quarantineEntryId: "entry-provider",
      quarantinePath: "/tmp/state/provider-quarantine/entry-provider.payload",
    });
    const completed = await journal.complete();

    expect(completed.reclaimedBytes).toBe(0);
    expect(completed.quarantinedBytes).toBe(20);
  });
});
