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

  it("selects eligible actions within the configured risk ceiling", () => {
    const audit: AuditReport = {
      ...AUDIT,
      findings: [
        {
          schemaVersion: 1,
          findingId: "finding-1",
          auditId: AUDIT.auditId,
          observedAt: AUDIT.completedAt,
          resource: {
            id: "artifacts:build-artifact:one",
            adapter: "artifacts",
            kind: "build-artifact",
            canonicalKey: "artifacts:/tmp/project/node_modules",
            displayName: "node_modules",
            path: "/tmp/project/node_modules",
          },
          state: "eligible",
          confidence: "certain",
          roots: [],
          facts: {},
          candidateActions: [
            {
              actionId: "action-1",
              type: "artifacts.remove",
              adapter: "artifacts",
              resourceId: "artifacts:build-artifact:one",
              risk: "safe",
              description: "Remove node_modules",
              expectedReclaimBytes: 1024,
              target: {
                path: "/tmp/project/node_modules",
                projectRoot: "/tmp/project",
                name: "node_modules",
                device: 1,
                inode: 2,
                mtimeMs: 3,
                measuredBytes: 1024,
                newestMtimeMs: 4,
                fingerprint: "a".repeat(64),
              },
            },
          ],
          measuredBytes: 1024,
          estimatedReclaimBytes: 1024,
          warnings: [],
        },
      ],
    };

    const plan = createCleanupPlan(audit, DEFAULT_CONFIG, new Date("2026-07-23T02:00:00.000Z"));

    expect(plan.home).toBe(AUDIT.home);
    expect(plan.actions).toHaveLength(1);
    expect(plan.expectedReclaimBytes).toBe(1024);
  });

  it("tracks quarantined bytes separately from immediate reclaim", () => {
    const audit: AuditReport = {
      ...AUDIT,
      findings: [
        {
          schemaVersion: 1,
          findingId: "finding-worktree",
          auditId: AUDIT.auditId,
          observedAt: AUDIT.completedAt,
          resource: {
            id: "git:git-worktree:fixture",
            adapter: "git",
            kind: "git-worktree",
            canonicalKey: "git:/tmp/repo-worktree",
            displayName: "repo-worktree",
            path: "/tmp/repo-worktree",
          },
          state: "eligible",
          confidence: "certain",
          roots: [],
          facts: {},
          candidateActions: [
            {
              actionId: "action-worktree",
              type: "worktree.quarantine",
              adapter: "git",
              resourceId: "git:git-worktree:fixture",
              risk: "recoverable",
              description: "Quarantine inactive linked worktree",
              expectedReclaimBytes: 0,
              pendingQuarantineBytes: 2048,
              quarantineTtlMinutes: 7 * 24 * 60,
              target: {
                path: "/tmp/repo-worktree",
                repositoryCommonDir: "/tmp/repo/.git",
                head: "a".repeat(40),
                branch: "refs/heads/feature",
                device: 1,
                inode: 2,
                mtimeMs: 3,
                measuredBytes: 2048,
                newestMtimeMs: 4,
                fingerprint: "b".repeat(64),
              },
            },
          ],
          measuredBytes: 2048,
          estimatedReclaimBytes: 0,
          warnings: [],
        },
      ],
    };
    const config = {
      ...DEFAULT_CONFIG,
      plan: { ...DEFAULT_CONFIG.plan, maxRisk: "recoverable" as const },
    };

    const plan = createCleanupPlan(audit, config, new Date("2026-07-24T02:00:00.000Z"));

    expect(plan.actions).toHaveLength(1);
    expect(plan.expectedReclaimBytes).toBe(0);
    expect(plan.pendingQuarantineBytes).toBe(2048);
  });
});
