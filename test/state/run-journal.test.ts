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
});
