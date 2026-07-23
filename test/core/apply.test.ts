import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AgentRinseConfig } from "../../src/config/schema.js";
import type { ArtifactRemoveAction } from "../../src/contracts/action.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import { ArtifactExecutionError, executeArtifactRemove } from "../../src/core/artifact-executor.js";
import { ApplySafetyError, applyCleanupPlan } from "../../src/core/apply.js";
import { sha256Json } from "../../src/core/digest.js";
import { measurePath } from "../../src/core/measure.js";
import { cleanupPlanId } from "../../src/core/plan.js";
import { readJsonFile } from "../../src/state/json-file.js";

async function fixture(): Promise<{
  action: ArtifactRemoveAction;
  config: AgentRinseConfig;
  plan: CleanupPlan;
  project: string;
  stateRoot: string;
  target: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-apply-"));
  const stateRoot = join(home, "state");
  const project = join(home, "project");
  const target = join(project, "node_modules");
  await mkdir(target, { recursive: true });
  await writeFile(join(project, "source.ts"), "keep");
  await writeFile(join(target, "cache.bin"), "remove");
  const stats = await stat(target);
  const measurement = await measurePath(target, { maxEntries: 100 });
  const config: AgentRinseConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    artifacts: {
      ...structuredClone(DEFAULT_CONFIG.artifacts),
      projects: [{ root: project, names: ["node_modules"] }],
      minAgeMinutes: 0,
      minBytes: 0,
    },
  };
  const action: ArtifactRemoveAction = {
    actionId: "action-1",
    type: "artifacts.remove",
    adapter: "artifacts",
    resourceId: "resource-1",
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
    },
  };
  const content: Omit<CleanupPlan, "planId"> = {
    schemaVersion: 1,
    auditId: "audit-1",
    home,
    createdAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-23T01:00:00.000Z",
    policyVersion: 1,
    riskCeiling: "safe",
    configDigest: sha256Json(config),
    auditDigest: "audit",
    actions: [action],
    expectedReclaimBytes: measurement.bytes,
  };
  const plan = { ...content, planId: cleanupPlanId(content) };
  return { action, config, plan, project, stateRoot, target };
}

const CLOCK = () => new Date("2026-07-23T00:30:00.000Z");

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("applyCleanupPlan", () => {
  it("revalidates, journals, and applies an authorized action", async () => {
    const value = await fixture();
    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        revalidate: async () => ({
          status: "valid",
          measurement: {
            bytes: value.action.target.measuredBytes,
            entries: 2,
            symlinksSkipped: 0,
            truncated: false,
          },
        }),
      },
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.actions[0]?.status).toBe("applied");
    expect(await exists(value.target)).toBe(false);
    expect(await readFile(join(value.project, "source.ts"), "utf8")).toBe("keep");
    expect(await readJsonFile(result.journalPath)).toEqual(result.run);
  });

  it("records changed resources as skipped without mutation", async () => {
    const value = await fixture();
    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        revalidate: async () => ({
          status: "stale",
          diagnostic: {
            severity: "warning",
            code: "ARTIFACT_IDENTITY_CHANGED",
            message: "fixture changed",
          },
        }),
      },
    });

    expect(result.run.actions[0]?.status).toBe("skipped-stale");
    expect(await exists(value.target)).toBe(true);
  });

  it("records partial execution and stops the run", async () => {
    const value = await fixture();
    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        revalidate: async () => ({
          status: "valid",
          measurement: {
            bytes: value.action.target.measuredBytes,
            entries: 2,
            symlinksSkipped: 0,
            truncated: false,
          },
        }),
        execute: async (action, isolationId) =>
          executeArtifactRemove(action, {
            id: () => isolationId,
            remove: async () => {
              throw new Error("injected removal failure");
            },
          }),
      },
    });

    expect(result.run.status).toBe("failed");
    expect(result.run.actions[0]).toMatchObject({
      status: "partially-applied",
      diagnostic: { code: "ARTIFACT_PARTIALLY_APPLIED" },
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("releases the apply lock after an unexpected journaled failure", async () => {
    const value = await fixture();
    const execute = async (): Promise<never> => {
      throw new ArtifactExecutionError("injected failure", "failed");
    };

    await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        revalidate: async () => ({
          status: "valid",
          measurement: {
            bytes: value.action.target.measuredBytes,
            entries: 2,
            symlinksSkipped: 0,
            truncated: false,
          },
        }),
        execute,
      },
    });

    await expect(
      applyCleanupPlan({
        input: value.plan,
        config: value.config,
        stateRoot: value.stateRoot,
        dependencies: {
          clock: CLOCK,
          revalidate: async () => ({
            status: "stale",
            diagnostic: {
              severity: "warning",
              code: "STALE",
              message: "skip",
            },
          }),
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a state directory beneath a cleanup target", async () => {
    const value = await fixture();

    await expect(
      applyCleanupPlan({
        input: value.plan,
        config: value.config,
        stateRoot: join(value.target, "state"),
        dependencies: { clock: CLOCK },
      }),
    ).rejects.toBeInstanceOf(ApplySafetyError);
  });
});
