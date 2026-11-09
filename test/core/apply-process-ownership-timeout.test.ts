import { lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AgentRinseConfig } from "../../src/config/schema.js";
import type { ArtifactRemoveAction, WorktreeQuarantineAction } from "../../src/contracts/action.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import { applyCleanupPlan } from "../../src/core/apply.js";
import { sha256Json } from "../../src/core/digest.js";
import { measurePath } from "../../src/core/measure.js";
import { cleanupPlanId } from "../../src/core/plan.js";
import { assertDestructiveFixtureRoot } from "../../src/core/safety.js";

const CONFIGURED_TIMEOUT_MS = 45_000;

const probe = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; timeoutMs: number | undefined }>,
}));

vi.mock("../../src/core/process-ownership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/process-ownership.js")>();
  return {
    ...actual,
    findProcessesUsingPath: vi.fn(async (path: string, options: { timeoutMs?: number } = {}) => {
      probe.calls.push({ path, timeoutMs: options.timeoutMs });
      return { status: "idle" as const, matches: [] };
    }),
  };
});

function planWindow(): { createdAt: string; expiresAt: string } {
  const now = Date.now();
  return {
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 29 * 60_000).toISOString(),
  };
}

async function syntheticHome(prefix: string): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await assertDestructiveFixtureRoot(home);
  return home;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("apply-time process ownership budget", () => {
  beforeEach(() => {
    probe.calls.length = 0;
  });

  it("repeats artifact ownership probes with the configured budget", async () => {
    const home = await syntheticHome("agentrinse-apply-ownership-");
    const project = join(home, "project");
    const target = join(project, "node_modules");
    await mkdir(target, { recursive: true });
    await writeFile(join(project, "source.ts"), "keep");
    await writeFile(join(target, "cache.bin"), "remove");
    const stats = await stat(target);
    const measurement = await measurePath(target, { maxEntries: 100 });
    const config: AgentRinseConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      audit: {
        ...structuredClone(DEFAULT_CONFIG.audit),
        processOwnershipTimeoutMs: CONFIGURED_TIMEOUT_MS,
      },
      artifacts: {
        ...structuredClone(DEFAULT_CONFIG.artifacts),
        projects: [{ root: project, names: ["node_modules"] }],
        minAgeMinutes: 0,
        minBytes: 0,
      },
    };
    const action: ArtifactRemoveAction = {
      actionId: "action-ownership",
      type: "artifacts.remove",
      adapter: "artifacts",
      resourceId: "resource-ownership",
      risk: "safe",
      description: "remove fixture artifact",
      expectedReclaimBytes: measurement.bytes,
      target: {
        path: target,
        projectRoot: project,
        name: "node_modules",
        device: stats.dev,
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        measuredBytes: measurement.bytes,
        newestMtimeMs: measurement.newestMtimeMs,
        fingerprint: measurement.fingerprint,
      },
    };
    const content: Omit<CleanupPlan, "planId"> = {
      schemaVersion: 1,
      auditId: "audit-ownership",
      home,
      ...planWindow(),
      policyVersion: 1,
      riskCeiling: "safe",
      configDigest: sha256Json(config),
      auditDigest: "audit",
      actions: [action],
      expectedReclaimBytes: measurement.bytes,
    };

    const result = await applyCleanupPlan({
      input: { ...content, planId: cleanupPlanId(content) },
      config,
      stateRoot: join(home, "state"),
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.actions[0]?.status).toBe("applied");
    expect(await exists(target)).toBe(false);
    expect(await readFile(join(project, "source.ts"), "utf8")).toBe("keep");
    // Revalidation probes the artifact; the executor probes it again around isolation.
    expect(probe.calls.length).toBeGreaterThanOrEqual(2);
    expect(probe.calls.every((call) => call.timeoutMs === CONFIGURED_TIMEOUT_MS)).toBe(true);
  });

  it("hands the configured budget to the worktree executor", async () => {
    const home = await syntheticHome("agentrinse-apply-worktree-ownership-");
    const repository = join(home, "repo");
    const commonDir = join(repository, ".git");
    const target = join(home, "task");
    await mkdir(commonDir, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, "fixture.txt"), "quarantine");
    const stats = await stat(target);
    const measurement = await measurePath(target, { maxEntries: 100 });
    const config: AgentRinseConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      adapters: {
        ...structuredClone(DEFAULT_CONFIG.adapters),
        git: { enabled: true, root: repository },
      },
      audit: {
        ...structuredClone(DEFAULT_CONFIG.audit),
        processOwnershipTimeoutMs: CONFIGURED_TIMEOUT_MS,
      },
      plan: { ...structuredClone(DEFAULT_CONFIG.plan), maxRisk: "recoverable" },
    };
    const action: WorktreeQuarantineAction = {
      actionId: "worktree.quarantine:ownership",
      type: "worktree.quarantine",
      adapter: "git",
      resourceId: "git:git-worktree:ownership",
      risk: "recoverable",
      description: "quarantine fixture worktree",
      expectedReclaimBytes: 0,
      pendingQuarantineBytes: measurement.bytes,
      quarantineTtlMinutes: 60,
      target: {
        path: target,
        repositoryCommonDir: commonDir,
        head: "a".repeat(40),
        branch: "refs/heads/feature",
        device: stats.dev,
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        measuredBytes: measurement.bytes,
        newestMtimeMs: measurement.newestMtimeMs,
        fingerprint: measurement.fingerprint,
      },
    };
    const content: Omit<CleanupPlan, "planId"> = {
      schemaVersion: 1,
      auditId: "audit-worktree-ownership",
      home,
      ...planWindow(),
      policyVersion: 1,
      riskCeiling: "recoverable",
      configDigest: sha256Json(config),
      auditDigest: "audit",
      actions: [action],
      expectedReclaimBytes: 0,
      pendingQuarantineBytes: measurement.bytes,
    };
    let probed = false;

    const result = await applyCleanupPlan({
      input: { ...content, planId: cleanupPlanId(content) },
      config,
      stateRoot: join(home, "state"),
      dependencies: {
        revalidateWorktree: async () => ({
          status: "valid",
          report: {
            schemaVersion: 1,
            auditId: "fresh-audit",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            home,
            probes: [],
            findings: [],
            diagnostics: [],
          },
          action,
        }),
        worktreeProtectionRoots: async () => [],
        executeWorktree: async (selectedAction, options) => {
          const ownership = await options.dependencies?.processProbe?.(selectedAction.target.path);
          probed = ownership?.status === "idle";
          return {
            quarantineEntryId: options.entryId,
            quarantinePath: join(home, ".agentrinse-quarantine", options.entryId),
            recoveryRef: `refs/agentrinse/quarantine/${options.runId}/ownership`,
            quarantinedBytes: selectedAction.target.measuredBytes,
            manifestPath: join(options.quarantineDirectory, `${options.entryId}.json`),
          };
        },
      },
    });

    expect(result.run.status).toBe("completed");
    expect(probed).toBe(true);
    expect(probe.calls).toEqual([{ path: target, timeoutMs: CONFIGURED_TIMEOUT_MS }]);
  });
});
