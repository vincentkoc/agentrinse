import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AgentRinseConfig } from "../../src/config/schema.js";
import type { ArtifactRemoveAction, WorktreeQuarantineAction } from "../../src/contracts/action.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import { ArtifactExecutionError, executeArtifactRemove } from "../../src/core/artifact-executor.js";
import { ApplySafetyError, applyCleanupPlan } from "../../src/core/apply.js";
import { sha256Json } from "../../src/core/digest.js";
import { measurePath } from "../../src/core/measure.js";
import { cleanupPlanId } from "../../src/core/plan.js";
import { assertDestructiveFixtureRoot } from "../../src/core/safety.js";
import { readJsonFile } from "../../src/state/json-file.js";
import { createRunJournal } from "../../src/state/run-journal.js";

async function fixture(): Promise<{
  action: ArtifactRemoveAction;
  config: AgentRinseConfig;
  plan: CleanupPlan;
  project: string;
  stateRoot: string;
  target: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-apply-")));
  await assertDestructiveFixtureRoot(home);
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
      newestMtimeMs: measurement.newestMtimeMs,
      fingerprint: measurement.fingerprint,
    },
  };
  const content: Omit<CleanupPlan, "planId"> = {
    schemaVersion: 1,
    auditId: "audit-1",
    home,
    createdAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-23T00:30:00.000Z",
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

async function worktreeFixture(): Promise<{
  action: WorktreeQuarantineAction;
  config: AgentRinseConfig;
  plan: CleanupPlan;
  stateRoot: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-worktree-apply-")));
  await assertDestructiveFixtureRoot(home);
  const repository = join(home, "repo");
  const commonDir = join(repository, ".git");
  const target = join(home, "task");
  const stateRoot = join(home, "state");
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
    plan: {
      ...structuredClone(DEFAULT_CONFIG.plan),
      maxRisk: "recoverable",
    },
  };
  const action: WorktreeQuarantineAction = {
    actionId: "worktree.quarantine:fixture",
    type: "worktree.quarantine",
    adapter: "git",
    resourceId: "git:git-worktree:fixture",
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
    auditId: "audit-worktree",
    home,
    createdAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-23T00:30:00.000Z",
    policyVersion: 1,
    riskCeiling: "recoverable",
    configDigest: sha256Json(config),
    auditDigest: "audit",
    actions: [action],
    expectedReclaimBytes: 0,
    pendingQuarantineBytes: measurement.bytes,
  };
  return {
    action,
    config,
    plan: { ...content, planId: cleanupPlanId(content) },
    stateRoot,
  };
}

const CLOCK = () => new Date("2026-07-23T00:15:00.000Z");

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
            specialEntries: 0,
            truncated: false,
            newestMtimeMs: value.action.target.newestMtimeMs,
            fingerprint: value.action.target.fingerprint,
            mountBoundaries: 0,
          },
        }),
        execute: async (action, isolationId) =>
          executeArtifactRemove(action, {
            id: () => isolationId,
            processProbe: async () => ({ status: "idle", matches: [] }),
          }),
      },
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.actions[0]?.status).toBe("applied");
    expect(await exists(value.target)).toBe(false);
    expect(await readFile(join(value.project, "source.ts"), "utf8")).toBe("keep");
    expect(await readJsonFile(result.journalPath)).toEqual(result.run);
  });

  it("dispatches and journals recoverable worktree quarantine", async () => {
    const value = await worktreeFixture();

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        revalidateWorktree: async () => ({
          status: "valid",
          report: {
            schemaVersion: 1,
            auditId: "fresh-audit",
            startedAt: "2026-07-23T00:14:00.000Z",
            completedAt: "2026-07-23T00:14:01.000Z",
            home: value.plan.home,
            probes: [],
            findings: [],
            diagnostics: [],
          },
          action: value.action,
        }),
        executeWorktree: async (action, options) => ({
          quarantineEntryId: options.entryId,
          quarantinePath: join(value.plan.home, ".agentrinse-quarantine", options.entryId),
          recoveryRef: `refs/agentrinse/quarantine/${options.runId}/fixture`,
          quarantinedBytes: action.target.measuredBytes,
          manifestPath: join(options.quarantineDirectory, `${options.entryId}.json`),
        }),
      },
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.reclaimedBytes).toBe(0);
    expect(result.run.quarantinedBytes).toBe(value.action.target.measuredBytes);
    expect(result.run.actions[0]).toMatchObject({
      type: "worktree.quarantine",
      status: "applied",
      reclaimedBytes: 0,
      quarantinedBytes: value.action.target.measuredBytes,
    });
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
            specialEntries: 0,
            truncated: false,
            newestMtimeMs: value.action.target.newestMtimeMs,
            fingerprint: value.action.target.fingerprint,
            mountBoundaries: 0,
          },
        }),
        execute: async (action, isolationId) =>
          executeArtifactRemove(action, {
            id: () => isolationId,
            remove: async () => {
              throw new Error("injected removal failure");
            },
            processProbe: async () => ({ status: "idle", matches: [] }),
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
            specialEntries: 0,
            truncated: false,
            newestMtimeMs: value.action.target.newestMtimeMs,
            fingerprint: value.action.target.fingerprint,
            mountBoundaries: 0,
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

  it("skips an action when plan authorization expires after revalidation", async () => {
    const value = await fixture();
    const times = [
      "2026-07-23T00:15:00.000Z",
      "2026-07-23T00:15:00.000Z",
      "2026-07-23T00:29:59.000Z",
      "2026-07-23T00:30:00.000Z",
      "2026-07-23T00:30:00.000Z",
    ].map((time) => new Date(time));
    const clock = () => times.shift() ?? new Date("2026-07-23T00:30:00.000Z");
    const execute = vi.fn();

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock,
        revalidate: async () => ({
          status: "valid",
          measurement: {
            bytes: value.action.target.measuredBytes,
            entries: 2,
            symlinksSkipped: 0,
            specialEntries: 0,
            truncated: false,
            newestMtimeMs: value.action.target.newestMtimeMs,
            fingerprint: value.action.target.fingerprint,
            mountBoundaries: 0,
          },
        }),
        execute,
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.run.actions[0]).toMatchObject({
      status: "skipped-stale",
      diagnostic: { code: "PLAN_EXPIRED_DURING_APPLY" },
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("journals executor-side authorization expiry as skipped-stale", async () => {
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
            specialEntries: 0,
            truncated: false,
            newestMtimeMs: value.action.target.newestMtimeMs,
            fingerprint: value.action.target.fingerprint,
            mountBoundaries: 0,
          },
        }),
        execute: async () => {
          throw new ArtifactExecutionError(
            "cleanup plan authorization expired before artifact isolation",
            "skipped-stale",
            undefined,
            { diagnosticCode: "PLAN_EXPIRED_DURING_APPLY" },
          );
        },
      },
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.actions[0]).toMatchObject({
      status: "skipped-stale",
      diagnostic: { code: "PLAN_EXPIRED_DURING_APPLY" },
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("does not rewrite an applied deletion as failed when journal persistence fails", async () => {
    const value = await fixture();
    let journalPath = "";

    await expect(
      applyCleanupPlan({
        input: value.plan,
        config: value.config,
        stateRoot: value.stateRoot,
        dependencies: {
          clock: CLOCK,
          createJournal: async (runsDirectory, plan, startedAt, runId) => {
            const journal = await createRunJournal(runsDirectory, plan, startedAt, runId);
            journalPath = journal.path;
            return {
              ...journal,
              updateAction: async (actionId, patch) => {
                if (patch.status === "applied") {
                  throw new Error("injected applied journal persistence failure");
                }
                return journal.updateAction(actionId, patch);
              },
            };
          },
          revalidate: async () => ({
            status: "valid",
            measurement: {
              bytes: value.action.target.measuredBytes,
              entries: 2,
              symlinksSkipped: 0,
              specialEntries: 0,
              truncated: false,
              newestMtimeMs: value.action.target.newestMtimeMs,
              fingerprint: value.action.target.fingerprint,
              mountBoundaries: 0,
            },
          }),
          execute: async (action, isolationId) =>
            executeArtifactRemove(action, {
              id: () => isolationId,
              processProbe: async () => ({ status: "idle", matches: [] }),
            }),
        },
      }),
    ).rejects.toThrow("injected applied journal persistence failure");

    expect(await exists(value.target)).toBe(false);
    await expect(readJsonFile(journalPath)).resolves.toMatchObject({
      status: "running",
      actions: [{ status: "applying" }],
    });
  });

  it("validates config at the exported mutation boundary", async () => {
    const value = await fixture();
    const invalidConfig = {
      ...value.config,
      artifacts: {
        ...value.config.artifacts,
        projects: [
          {
            root: value.project,
            names: ["src"],
          },
        ],
      },
    } as unknown as AgentRinseConfig;

    await expect(
      applyCleanupPlan({
        input: value.plan,
        config: invalidConfig,
        stateRoot: value.stateRoot,
        dependencies: { clock: CLOCK },
      }),
    ).rejects.toThrow();
    expect(await exists(value.target)).toBe(true);
  });

  it("rejects a state symlink that resolves beneath a cleanup target", async () => {
    const value = await fixture();
    const physicalState = join(value.target, "state");
    const stateLink = join(value.project, "state-link");
    await mkdir(physicalState);
    await symlink(physicalState, stateLink);

    await expect(
      applyCleanupPlan({
        input: value.plan,
        config: value.config,
        stateRoot: stateLink,
        dependencies: { clock: CLOCK },
      }),
    ).rejects.toBeInstanceOf(ApplySafetyError);
  });

  it("journals interruption at a safe checkpoint and leaves the target intact", async () => {
    const value = await fixture();
    const controller = new AbortController();

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      signal: controller.signal,
      dependencies: {
        clock: CLOCK,
        createJournal: async (runsDirectory, plan, startedAt, runId) => {
          const journal = await createRunJournal(runsDirectory, plan, startedAt, runId);
          controller.abort(new Error("fixture interruption"));
          return journal;
        },
      },
    });

    expect(result.run.status).toBe("interrupted");
    expect(result.run.actions[0]?.status).toBe("pending");
    expect(result.run.diagnostics[0]?.code).toBe("COMMAND_INTERRUPTED");
    expect(await exists(value.target)).toBe(true);
    await expect(readJsonFile(result.journalPath)).resolves.toEqual(result.run);

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

  it("journals interruption requested during stale revalidation", async () => {
    const value = await fixture();
    const controller = new AbortController();

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      signal: controller.signal,
      dependencies: {
        clock: CLOCK,
        revalidate: async () => {
          controller.abort(new Error("fixture interruption"));
          return {
            status: "stale",
            diagnostic: {
              severity: "warning",
              code: "ARTIFACT_IDENTITY_CHANGED",
              message: "fixture changed",
            },
          };
        },
      },
    });

    expect(result.run.status).toBe("interrupted");
    expect(result.run.actions[0]?.status).toBe("skipped-stale");
    expect(result.run.diagnostics[0]?.code).toBe("COMMAND_INTERRUPTED");
    expect(await exists(value.target)).toBe(true);
  });

  it("journals interruption requested while finalizing a completed run", async () => {
    const value = await fixture();
    const controller = new AbortController();

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      signal: controller.signal,
      dependencies: {
        clock: CLOCK,
        createJournal: async (runsDirectory, plan, startedAt, runId) => {
          const journal = await createRunJournal(runsDirectory, plan, startedAt, runId);
          return {
            ...journal,
            complete: async (completedAt) => {
              const run = await journal.complete(completedAt);
              controller.abort(new Error("fixture interruption"));
              return run;
            },
          };
        },
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

    expect(result.run.status).toBe("interrupted");
    expect(result.run.actions[0]?.status).toBe("skipped-stale");
    expect(result.run.diagnostics[0]?.code).toBe("COMMAND_INTERRUPTED");
    expect(await exists(value.target)).toBe(true);
    await expect(readJsonFile(result.journalPath)).resolves.toEqual(result.run);
  });

  it("does not mask a real failure just because interruption was also requested", async () => {
    const value = await fixture();
    const controller = new AbortController();

    await expect(
      applyCleanupPlan({
        input: value.plan,
        config: value.config,
        stateRoot: value.stateRoot,
        signal: controller.signal,
        dependencies: {
          clock: CLOCK,
          revalidate: async () => {
            controller.abort(new Error("fixture interruption"));
            throw new Error("authoritative revalidation failure");
          },
        },
      }),
    ).rejects.toThrow("authoritative revalidation failure");
    expect(await exists(value.target)).toBe(true);
  });
});
