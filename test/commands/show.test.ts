import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeShowPlanCommand,
  executeShowResourceCommand,
  executeShowRunCommand,
} from "../../src/commands/show.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import type { AuditReport } from "../../src/contracts/report.js";
import type { CleanupRun } from "../../src/contracts/run.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";
import { stateLayout } from "../../src/state/layout.js";

const RUN: CleanupRun = {
  schemaVersion: 1,
  runId: "run-1",
  planId: "plan-1",
  startedAt: "2026-07-24T00:00:00.000Z",
  completedAt: "2026-07-24T00:01:00.000Z",
  status: "partial",
  actions: [
    {
      actionId: "action-1",
      type: "artifacts.remove",
      status: "partially-applied",
      isolationPath: "/tmp/project/.agentrinse-tombstone",
      diagnostic: {
        severity: "error",
        code: "ARTIFACT_PARTIALLY_APPLIED",
        message: "synthetic partial action",
      },
    },
  ],
  reclaimedBytes: 0,
  diagnostics: [],
};

const PLAN: CleanupPlan = {
  schemaVersion: 1,
  planId: "plan-1",
  auditId: "audit-1",
  home: "/tmp/home",
  createdAt: "2026-07-24T00:00:00.000Z",
  expiresAt: "2026-07-24T00:30:00.000Z",
  policyVersion: 1,
  riskCeiling: "safe",
  configDigest: "config",
  auditDigest: "audit",
  actions: [],
  expectedReclaimBytes: 0,
};

const AUDIT: AuditReport = {
  schemaVersion: 1,
  auditId: "audit-1",
  startedAt: "2026-07-24T00:00:00.000Z",
  completedAt: "2026-07-24T00:00:01.000Z",
  home: "/tmp/home",
  probes: [],
  findings: [
    {
      schemaVersion: 1,
      findingId: "finding-1",
      auditId: "audit-1",
      observedAt: "2026-07-24T00:00:01.000Z",
      resource: {
        id: "resource-1",
        adapter: "codex",
        kind: "agent-session-store",
        canonicalKey: "codex:/tmp/home/.codex/sessions",
        displayName: "sessions",
        path: "/tmp/home/.codex/sessions",
      },
      state: "protected",
      confidence: "certain",
      roots: [],
      facts: {},
      candidateActions: [],
      warnings: [],
    },
  ],
  diagnostics: [],
};

describe("show commands", () => {
  it("shows runs with partial recovery guidance", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agentrinse-show-"));
    const layout = stateLayout(stateRoot);
    await writeJsonAtomic(join(layout.runs, "run-1.json"), RUN);

    const result = await executeShowRunCommand("run-1", {
      home: "/unused",
      stateDir: stateRoot,
      json: false,
    });

    expect(result.output).toContain("Recovery:");
    expect(result.output).toContain(".agentrinse-tombstone");
  });

  it("shows plans by id and resources from the latest audit", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agentrinse-show-"));
    const layout = stateLayout(stateRoot);
    await writeJsonAtomic(join(layout.plans, "plan-1.json"), PLAN);
    await writeJsonAtomic(join(layout.audits, "audit-1.json"), AUDIT);

    expect(
      (
        await executeShowPlanCommand("plan-1", {
          home: "/unused",
          stateDir: stateRoot,
          json: true,
        })
      ).value.planId,
    ).toBe("plan-1");
    expect(
      (
        await executeShowResourceCommand("resource-1", {
          home: "/unused",
          stateDir: stateRoot,
          json: true,
        })
      ).value.finding.findingId,
    ).toBe("finding-1");
  });
});
