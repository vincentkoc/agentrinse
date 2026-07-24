import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { WorktreeQuarantineAction } from "../../src/contracts/action.js";
import type { AuditReport } from "../../src/contracts/report.js";
import { revalidateWorktreeQuarantine } from "../../src/core/worktree-revalidation.js";

const ACTION: WorktreeQuarantineAction = {
  actionId: "worktree.quarantine:fixture",
  type: "worktree.quarantine",
  adapter: "git",
  resourceId: "git:git-worktree:fixture",
  risk: "recoverable",
  description: "quarantine fixture",
  expectedReclaimBytes: 0,
  pendingQuarantineBytes: 1024,
  quarantineTtlMinutes: 60,
  target: {
    path: "/tmp/worktree",
    repositoryCommonDir: "/tmp/repo/.git",
    head: "a".repeat(40),
    branch: "refs/heads/feature",
    device: 1,
    inode: 2,
    mtimeMs: 3,
    measuredBytes: 1024,
    newestMtimeMs: 4,
    fingerprint: "b".repeat(64),
  },
};

function report(action: WorktreeQuarantineAction = ACTION): AuditReport {
  return {
    schemaVersion: 1,
    auditId: "audit-fresh",
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: "2026-07-24T00:00:01.000Z",
    home: "/tmp",
    probes: [],
    findings: [
      {
        schemaVersion: 1,
        findingId: "finding-fresh",
        auditId: "audit-fresh",
        observedAt: "2026-07-24T00:00:00.000Z",
        resource: {
          id: ACTION.resourceId,
          adapter: "git",
          kind: "git-worktree",
          canonicalKey: "git:/tmp/worktree",
          displayName: "Linked worktree",
          path: ACTION.target.path,
        },
        state: "eligible",
        confidence: "certain",
        roots: [],
        facts: {},
        candidateActions: [action],
        measuredBytes: 1024,
        estimatedReclaimBytes: 0,
        warnings: [],
      },
    ],
    diagnostics: [],
  };
}

describe("revalidateWorktreeQuarantine", () => {
  it("accepts only the exact freshly audited action", async () => {
    const audit = vi.fn(async () => report());

    const result = await revalidateWorktreeQuarantine(ACTION, "/tmp", DEFAULT_CONFIG, {
      platform: "linux",
      audit,
    });

    expect(result.status).toBe("valid");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("rejects changed identity even when the resource remains eligible", async () => {
    const changed: WorktreeQuarantineAction = {
      ...ACTION,
      target: { ...ACTION.target, fingerprint: "c".repeat(64) },
    };

    const result = await revalidateWorktreeQuarantine(ACTION, "/tmp", DEFAULT_CONFIG, {
      platform: "darwin",
      audit: async () => report(changed),
    });

    expect(result).toMatchObject({
      status: "stale",
      diagnostic: { code: "WORKTREE_IDENTITY_CHANGED" },
    });
  });

  it("blocks mutation on native Windows", async () => {
    const audit = vi.fn(async () => report());

    const result = await revalidateWorktreeQuarantine(ACTION, "/tmp", DEFAULT_CONFIG, {
      platform: "win32",
      audit,
    });

    expect(result).toMatchObject({
      status: "stale",
      diagnostic: { code: "WORKTREE_PLATFORM_UNSUPPORTED" },
    });
    expect(audit).not.toHaveBeenCalled();
  });
});
