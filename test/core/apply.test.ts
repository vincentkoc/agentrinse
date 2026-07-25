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

import { CODEX_DATABASE_CONTRACTS } from "../../src/adapters/codex-database.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AgentRinseConfig } from "../../src/config/schema.js";
import type {
  ArtifactRemoveAction,
  DatabaseVacuumAction,
  ProviderFileQuarantineAction,
  WorktreeQuarantineAction,
} from "../../src/contracts/action.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import { ArtifactExecutionError, executeArtifactRemove } from "../../src/core/artifact-executor.js";
import { ApplySafetyError, applyCleanupPlan } from "../../src/core/apply.js";
import { sha256Json } from "../../src/core/digest.js";
import { CommandInterruptedError } from "../../src/core/interruption.js";
import { measurePath } from "../../src/core/measure.js";
import { cleanupPlanId } from "../../src/core/plan.js";
import { inspectProviderFile } from "../../src/core/provider-file-identity.js";
import { assertDestructiveFixtureRoot } from "../../src/core/safety.js";
import { WorktreeExecutionError } from "../../src/core/worktree-executor.js";
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

async function databaseFixture(): Promise<{
  action: DatabaseVacuumAction;
  config: AgentRinseConfig;
  plan: CleanupPlan;
  stateRoot: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-database-apply-")));
  await assertDestructiveFixtureRoot(home);
  const root = join(home, ".codex");
  const path = join(root, "state_5.sqlite");
  const stateRoot = join(home, "state");
  await mkdir(root);
  await writeFile(path, "synthetic");
  const stats = await stat(path);
  const contract = CODEX_DATABASE_CONTRACTS["state_5.sqlite"];
  const config: AgentRinseConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    adapters: {
      ...structuredClone(DEFAULT_CONFIG.adapters),
      codex: { enabled: true, root },
    },
    plan: {
      ...structuredClone(DEFAULT_CONFIG.plan),
      maxRisk: "experimental",
    },
  };
  const action: DatabaseVacuumAction = {
    actionId: "database.vacuum:fixture",
    type: "database.vacuum",
    adapter: "codex",
    resourceId: "codex:agent-database:fixture",
    risk: "experimental",
    description: "compact fixture database",
    expectedReclaimBytes: 1,
    backupTtlMinutes: 60,
    target: {
      path,
      database: "state",
      filename: "state_5.sqlite",
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      measuredBytes: stats.size,
      pageSize: 4096,
      pageCount: 1,
      freelistCount: 1,
      journalMode: "wal",
      autoVacuum: 2,
      migrationVersion: contract.migrationVersion,
      migrationDigest: contract.migrationDigest,
      tables: ["_sqlx_migrations", "threads"],
      schemaDigest: contract.schemaDigest,
      fingerprint: "b".repeat(64),
    },
  };
  const content: Omit<CleanupPlan, "planId"> = {
    schemaVersion: 1,
    auditId: "audit-database",
    home,
    createdAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-23T00:30:00.000Z",
    policyVersion: 1,
    riskCeiling: "experimental",
    configDigest: sha256Json(config),
    auditDigest: "audit",
    actions: [action],
    expectedReclaimBytes: action.expectedReclaimBytes,
  };
  return {
    action,
    config,
    plan: { ...content, planId: cleanupPlanId(content) },
    stateRoot,
  };
}

async function providerFileFixture(): Promise<{
  action: ProviderFileQuarantineAction;
  config: AgentRinseConfig;
  plan: CleanupPlan;
  stateRoot: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-provider-apply-")));
  await assertDestructiveFixtureRoot(home);
  const ownerRoot = join(home, ".claude");
  const path = join(ownerRoot, "debug", "session.txt");
  const stateRoot = join(home, "state");
  await mkdir(join(ownerRoot, "debug"), { recursive: true });
  await writeFile(path, "synthetic debug output\n");
  const target = await inspectProviderFile(path, ownerRoot, "claude");
  const config: AgentRinseConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    adapters: {
      ...structuredClone(DEFAULT_CONFIG.adapters),
      claude: { enabled: true, root: ownerRoot },
    },
    plan: {
      ...structuredClone(DEFAULT_CONFIG.plan),
      maxRisk: "recoverable",
    },
  };
  const action: ProviderFileQuarantineAction = {
    actionId: "provider.file-quarantine:fixture",
    type: "provider.file-quarantine",
    adapter: "claude",
    resourceId: "claude:agent-log:fixture",
    policyId: "claude.debug-log",
    risk: "recoverable",
    description: "archive fixture provider log",
    expectedReclaimBytes: 0,
    pendingQuarantineBytes: target.measuredBytes,
    quarantineTtlMinutes: 60,
    target,
  };
  const content: Omit<CleanupPlan, "planId"> = {
    schemaVersion: 1,
    auditId: "audit-provider-file",
    home,
    createdAt: "2026-07-23T00:00:00.000Z",
    expiresAt: "2026-07-23T00:30:00.000Z",
    policyVersion: 1,
    riskCeiling: "recoverable",
    configDigest: sha256Json(config),
    auditDigest: "audit",
    actions: [action],
    expectedReclaimBytes: 0,
    pendingQuarantineBytes: target.measuredBytes,
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
    const worktreeProtectionRoots = vi.fn(async () => []);

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
        worktreeProtectionRoots,
        executeWorktree: async (action, options) => {
          await options.dependencies?.revalidateProtection?.();
          return {
            quarantineEntryId: options.entryId,
            quarantinePath: join(value.plan.home, ".agentrinse-quarantine", options.entryId),
            recoveryRef: `refs/agentrinse/quarantine/${options.runId}/fixture`,
            quarantinedBytes: action.target.measuredBytes,
            manifestPath: join(options.quarantineDirectory, `${options.entryId}.json`),
          };
        },
      },
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.reclaimedBytes).toBe(0);
    expect(result.run.quarantinedBytes).toBe(value.action.target.measuredBytes);
    expect(worktreeProtectionRoots).toHaveBeenCalledOnce();
    expect(result.run.actions[0]).toMatchObject({
      type: "worktree.quarantine",
      status: "applied",
      reclaimedBytes: 0,
      quarantinedBytes: value.action.target.measuredBytes,
    });
  });

  it("dispatches and journals recoverable provider-file quarantine", async () => {
    const value = await providerFileFixture();
    const executeProviderFile = vi.fn(async (action: ProviderFileQuarantineAction, options) => ({
      quarantineEntryId: options.entryId,
      quarantinePath: join(options.quarantineDirectory, `${options.entryId}.payload`),
      quarantinedBytes: action.target.measuredBytes,
      manifestPath: join(options.quarantineDirectory, `${options.entryId}.json`),
    }));

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        revalidateProviderFile: async () => ({ status: "ready" }),
        executeProviderFile,
      },
    });

    expect(executeProviderFile).toHaveBeenCalledOnce();
    expect(result.run.status).toBe("completed");
    expect(result.run.reclaimedBytes).toBe(0);
    expect(result.run.quarantinedBytes).toBe(value.action.target.measuredBytes);
    expect(result.run.actions[0]).toMatchObject({
      type: "provider.file-quarantine",
      status: "applied",
      reclaimedBytes: 0,
      quarantinedBytes: value.action.target.measuredBytes,
    });
  });

  it("reloads and unions protection config at the quarantine boundary", async () => {
    const value = await worktreeFixture();
    const currentConfig = structuredClone(value.config);
    currentConfig.pins = [{ path: value.action.target.path }];
    const loadCurrentConfig = vi.fn(async () => currentConfig);
    const worktreeProtectionRoots = vi.fn(
      async (_action: WorktreeQuarantineAction, _home: string, config: AgentRinseConfig) =>
        config.pins.some((pin) => "path" in pin && pin.path === value.action.target.path)
          ? [
              {
                code: "user-pin",
                source: "config",
                observedAt: "2026-07-23T00:15:00.000Z",
                detail: "The worktree was pinned after apply started.",
              },
            ]
          : [],
    );

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      dependencies: {
        clock: CLOCK,
        loadCurrentConfig,
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
        worktreeProtectionRoots,
        executeWorktree: async (_action, options) => {
          try {
            await options.dependencies?.revalidateProtection?.();
          } catch (error) {
            throw new WorktreeExecutionError(
              "worktree became protected before quarantine",
              "skipped-stale",
              undefined,
              {
                cause: error,
                diagnosticCode: "WORKTREE_PROTECTION_CHANGED",
              },
            );
          }
          throw new Error("unreachable");
        },
      },
    });

    expect(loadCurrentConfig).toHaveBeenCalledOnce();
    expect(worktreeProtectionRoots).toHaveBeenCalledTimes(2);
    expect(worktreeProtectionRoots.mock.calls.map((call) => call[2])).toEqual([
      value.config,
      currentConfig,
    ]);
    expect(result.run.status).toBe("completed");
    expect(result.run.actions[0]).toMatchObject({
      status: "skipped-stale",
      diagnostic: {
        code: "WORKTREE_PROTECTION_CHANGED",
      },
    });
  });

  it("accounts for bytes left in partial worktree quarantine", async () => {
    const value = await worktreeFixture();
    const partialEntry = {
      schemaVersion: 1 as const,
      entryId: "partial-entry",
      runId: "partial-run",
      actionId: value.action.actionId,
      resourceId: value.action.resourceId,
      status: "partial" as const,
      originalPath: value.action.target.path,
      quarantinePath: join(value.plan.home, ".agentrinse-quarantine", "partial-entry"),
      recoveryRef: "refs/agentrinse/quarantine/partial-run/fixture",
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: value.config.audit.maxEntries,
      target: value.action.target,
    };

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
        executeWorktree: async () => {
          throw new WorktreeExecutionError(
            "injected partial quarantine",
            "partially-applied",
            partialEntry,
            { quarantinedBytes: value.action.target.measuredBytes },
          );
        },
      },
    });

    expect(result.run.status).toBe("failed");
    expect(result.run.quarantinedBytes).toBe(value.action.target.measuredBytes);
    expect(result.run.actions[0]).toMatchObject({
      status: "partially-applied",
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

  it("journals database executor cancellation as an interrupted run", async () => {
    const value = await databaseFixture();
    const controller = new AbortController();

    const result = await applyCleanupPlan({
      input: value.plan,
      config: value.config,
      stateRoot: value.stateRoot,
      signal: controller.signal,
      dependencies: {
        clock: CLOCK,
        revalidateDatabase: async () => ({ status: "eligible" }),
        executeDatabase: async (_action, options) => {
          expect(options.signal).toBe(controller.signal);
          const interruption = new CommandInterruptedError("fixture interruption");
          controller.abort(interruption);
          throw interruption;
        },
      },
    });

    expect(result.run.status).toBe("interrupted");
    expect(result.run.actions[0]?.status).toBe("applying");
    expect(result.run.diagnostics[0]?.code).toBe("COMMAND_INTERRUPTED");
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
