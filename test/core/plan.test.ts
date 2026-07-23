import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AuditReport } from "../../src/contracts/report.js";
import { createCleanupPlan } from "../../src/core/plan.js";

const AUDIT: AuditReport = {
  schemaVersion: 1,
  auditId: "audit-1",
  startedAt: "2026-07-23T00:00:00.000Z",
  completedAt: "2026-07-23T00:00:01.000Z",
  home: "/tmp/agentrinse-home",
  probes: [],
  findings: [],
  diagnostics: [],
};

describe("createCleanupPlan", () => {
  it("creates a dry plan with no actions from report-only findings", () => {
    const plan = createCleanupPlan(AUDIT, DEFAULT_CONFIG, new Date("2026-07-23T02:00:00.000Z"));

    expect(plan.actions).toEqual([]);
    expect(plan.expectedReclaimBytes).toBe(0);
    expect(plan.expiresAt).toBe("2026-07-23T02:30:00.000Z");
  });

  it("is deterministic for identical inputs", () => {
    const now = new Date("2026-07-23T02:00:00.000Z");

    expect(createCleanupPlan(AUDIT, DEFAULT_CONFIG, now).planId).toBe(
      createCleanupPlan(AUDIT, DEFAULT_CONFIG, now).planId,
    );
  });
});
