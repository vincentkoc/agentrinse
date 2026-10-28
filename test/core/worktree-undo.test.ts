import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import { quarantineEntrySchema } from "../../src/contracts/quarantine.js";
import {
  executeWorktreeQuarantine,
  worktreeQuarantinePath,
  worktreeRecoveryRef,
} from "../../src/core/worktree-executor.js";
import { undoWorktreeQuarantine } from "../../src/core/worktree-undo.js";
import { measurePath } from "../../src/core/measure.js";
import { renameNoReplace } from "../../src/core/no-clobber-rename.js";
import { readJsonFile, writeJsonAtomic } from "../../src/state/json-file.js";
import {
  gitFixture,
  idle,
  lockReason,
  missing,
  occupyOriginalWhileRestoring,
  persistedStatus,
  quarantined,
} from "./worktree-fixture.js";

describe("worktree quarantine undo", () => {
  it("treats a missing recovery ref as absent with the production Git runner", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-missing-ref";
    const runId = "run-initial-missing-ref";
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "preparing",
      originalPath: fixture.linked,
      quarantinePath: worktreeQuarantinePath(fixture.action, entryId),
      recoveryRef: worktreeRecoveryRef(fixture.action, runId),
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(manifest, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
  });

  it("cleans up a recovery ref when quarantine was interrupted before the move", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-before-move";
    const runId = "run-initial-before-move";
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "recovery-ref-created",
      originalPath: fixture.linked,
      quarantinePath: worktreeQuarantinePath(fixture.action, entryId),
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(manifest, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        recoveryRef,
      ]),
    ).rejects.toThrow();
  });

  it("releases its owned lock after a pre-move interruption", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-owned-lock";
    const runId = "run-initial-owned-lock";
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      `AgentRinse quarantine ${entryId}`,
      fixture.linked,
    ]);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "recovery-ref-created",
      originalPath: fixture.linked,
      quarantinePath: worktreeQuarantinePath(fixture.action, entryId),
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(manifest, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records.find((record) => record.path === fixture.linked)?.locked).toBeUndefined();
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        recoveryRef,
      ]),
    ).rejects.toThrow();
  });

  it("restores a worktree moved before the quarantine manifest advanced", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-after-move";
    const runId = "run-initial-after-move";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await mkdir(dirname(quarantinePath), { recursive: true });
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "recovery-ref-created",
      originalPath: fixture.linked,
      quarantinePath,
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });
    await renameNoReplace(fixture.linked, quarantinePath);

    const restored = await undoWorktreeQuarantine(manifest, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(quarantinePath)).toBe(true);
  });

  it("repairs rollback interrupted after the worktree returned home", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-rollback-before-repair",
      entryId: "entry-rollback-before-repair",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, fixture.linked);
    const moved = quarantineEntrySchema.parse({ ...manifest, status: "moved" });
    await writeJsonAtomic(result.manifestPath, moved, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(moved, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: fixture.linked,
          head: fixture.action.target.head,
        }),
      ]),
    );
  });

  it("does not repair an interrupted move protected by a foreign lock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-foreign-lock";
    const runId = "run-initial-foreign-lock";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await mkdir(dirname(quarantinePath), { recursive: true });
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      "operator hold",
      fixture.linked,
    ]);
    await renameNoReplace(fixture.linked, quarantinePath);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "recovery-ref-created",
      originalPath: fixture.linked,
      quarantinePath,
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

    expect(await missing(quarantinePath)).toBe(false);
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: fixture.linked,
          locked: "operator hold",
        }),
      ]),
    );
  });

  it("checks Git operation markers before repairing an interrupted move", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-operation";
    const runId = "run-initial-operation";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await mkdir(dirname(quarantinePath), { recursive: true });
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    await renameNoReplace(fixture.linked, quarantinePath);
    const markerPath = (
      await fixture.runGit(["-C", quarantinePath, "rev-parse", "--git-path", "MERGE_HEAD"])
    ).trim();
    await writeFile(markerPath, `${fixture.action.target.head}\n`);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "recovery-ref-created",
      originalPath: fixture.linked,
      quarantinePath,
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_GIT_OPERATION_IN_PROGRESS",
    });

    expect(await missing(quarantinePath)).toBe(false);
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: fixture.linked })]),
    );
  });

  it("rejects a third-path registration before interrupted-move repair", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-initial-third-path";
    const runId = "run-initial-third-path";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const thirdPath = join(fixture.home, "third-path");
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await mkdir(dirname(quarantinePath), { recursive: true });
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    await renameNoReplace(fixture.linked, thirdPath);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "repair",
      thirdPath,
    ]);
    await renameNoReplace(thirdPath, quarantinePath);
    const manifest = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "recovery-ref-created",
      originalPath: fixture.linked,
      quarantinePath,
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
    });
    await writeJsonAtomic(manifestPath, manifest, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

    expect(await missing(quarantinePath)).toBe(false);
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ path: thirdPath })]));
  });

  it("restores the original path and deletes the exact recovery ref", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const runId = "run-undo";
    const entryId = "entry-undo";
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId,
      entryId,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
        maxEntries: 12_345,
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    expect(manifest.measurementMaxEntries).toBe(12_345);
    const measurementLimits: number[] = [];
    const runGit = async (args: string[]) => {
      if (args.includes("update-ref") && args.includes("-d")) {
        const persisted = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
        expect(persisted.status).toBe("restoring");
      }
      return fixture.runGit(args);
    };

    const restored = await undoWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit,
        measure: async (path, options) => {
          measurementLimits.push(options.maxEntries);
          return measurePath(path, options);
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(restored.status).toBe("restored");
    expect(measurementLimits).toEqual([12_345, 12_345]);
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(result.quarantinePath)).toBe(true);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        result.recoveryRef,
      ]),
    ).rejects.toThrow();
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: fixture.linked,
          head: fixture.action.target.head,
          branch: fixture.action.target.branch,
        }),
      ]),
    );
  });

  it("resumes an interrupted undo before unlock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-undo-locked",
      entryId: "entry-resume-undo-locked",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const restoring = quarantineEntrySchema.parse({ ...manifest, status: "restoring" });
    await writeJsonAtomic(result.manifestPath, restoring, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(restoring, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(result.quarantinePath)).toBe(true);
  });

  it("restores a partial entry from the quarantine path", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-partial-undo-quarantine",
      entryId: "entry-partial-undo-quarantine",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const partial = quarantineEntrySchema.parse({
      ...manifest,
      status: "partial",
      diagnostic: {
        severity: "error",
        code: "QUARANTINE_UNDO_PARTIAL",
        message: "injected interrupted undo",
        adapter: "git",
        resourceId: manifest.resourceId,
      },
    });
    await writeJsonAtomic(result.manifestPath, partial, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(partial, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(result.quarantinePath)).toBe(true);
  });

  it("releases its owned lock from a partial pre-move entry", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-partial-owned-lock";
    const runId = "run-partial-owned-lock";
    const recoveryRef = worktreeRecoveryRef(fixture.action, runId);
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      fixture.action.target.head,
      "",
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      `AgentRinse quarantine ${entryId}`,
      fixture.linked,
    ]);
    const partial = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId,
      runId,
      actionId: fixture.action.actionId,
      resourceId: fixture.action.resourceId,
      status: "partial",
      originalPath: fixture.linked,
      quarantinePath: worktreeQuarantinePath(fixture.action, entryId),
      recoveryRef,
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: fixture.action.target,
      diagnostic: {
        severity: "error",
        code: "WORKTREE_QUARANTINE_PARTIAL",
        message: "interrupted while releasing the pre-move lock",
        adapter: "git",
        resourceId: fixture.action.resourceId,
      },
    });
    await writeJsonAtomic(manifestPath, partial, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(partial, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records.find((record) => record.path === fixture.linked)?.locked).toBeUndefined();
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        recoveryRef,
      ]),
    ).rejects.toThrow();
  });

  it("rolls a partial purge isolation back before undo", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-partial-undo-isolation",
      entryId: "entry-partial-undo-isolation",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const partial = quarantineEntrySchema.parse({
      ...manifest,
      status: "partial",
      diagnostic: {
        severity: "error",
        code: "QUARANTINE_PURGE_PARTIAL",
        message: "injected interrupted purge rollback",
        adapter: "git",
        resourceId: manifest.resourceId,
      },
    });
    await writeJsonAtomic(result.manifestPath, partial, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(partial, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(isolationPath)).toBe(true);
  });

  it("finishes an interrupted undo after the worktree move", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-undo-moved",
      entryId: "entry-resume-undo-moved",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, fixture.linked);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      "-d",
      result.recoveryRef,
      fixture.action.target.head,
    ]);
    const restoring = quarantineEntrySchema.parse({ ...manifest, status: "restoring" });
    await writeJsonAtomic(result.manifestPath, restoring, {
      privateDirectories: [quarantineDirectory],
    });

    const restored = await undoWorktreeQuarantine(restoring, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    expect(await missing(fixture.linked)).toBe(false);
  });

  it("rolls back when the restored path becomes busy before commit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-undo-final-process",
      entryId: "entry-undo-final-process",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    let probes = 0;

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () =>
            ++probes === 1
              ? { status: "idle" as const, matches: [] }
              : { status: "busy" as const, matches: [] },
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_UNDO_FAILED",
    });

    expect(await missing(fixture.linked)).toBe(true);
    expect(await missing(result.quarantinePath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("does not overwrite a destination that appears in the final undo window", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-undo-race",
      entryId: "entry-undo-race",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
          move: async (source, destination) => {
            if (destination === fixture.linked) {
              await mkdir(destination);
              await writeFile(join(destination, "occupant.txt"), "do not replace\n");
            }
            await renameNoReplace(source, destination);
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_UNDO_FAILED",
    });

    await expect(readFile(join(fixture.linked, "occupant.txt"), "utf8")).resolves.toBe(
      "do not replace\n",
    );
    expect(await missing(result.quarantinePath)).toBe(false);
    const persisted = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    expect(persisted.status).toBe("quarantined");
  });

  it("blocks recovery mutation on native Windows", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-windows",
      entryId: "entry-windows",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          platform: "win32",
          runGit: fixture.runGit,
        },
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_PLATFORM_UNSUPPORTED",
    });
    expect(await missing(result.quarantinePath)).toBe(false);
  });

  it("relocks and keeps the entry when the original path is taken during undo", async () => {
    const fixture = await gitFixture();
    const { quarantineDirectory, result, manifest } = await quarantined(fixture, "undo-occupied");

    const error = await undoWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        ...idle,
        inspect: occupyOriginalWhileRestoring(fixture, result.manifestPath),
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "QUARANTINE_UNDO_FAILED" });
    expect((error as Error).cause).toMatchObject({
      message: `original path became occupied before undo: ${fixture.linked}`,
    });
    expect(await persistedStatus(result.manifestPath)).toBe("quarantined");
    await expect(readFile(join(fixture.linked, "occupant.txt"), "utf8")).resolves.toBe(
      "arrived during undo\n",
    );
    expect(await lockReason(fixture, result.quarantinePath)).toBe(
      "AgentRinse quarantine entry-undo-occupied",
    );
  });

  it("records partial state when undo cannot relock after failing", async () => {
    const fixture = await gitFixture();
    const { quarantineDirectory, result, manifest } = await quarantined(fixture, "undo-partial");
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("lock")) {
        throw new Error("injected relock failure");
      }
      return fixture.runGit(args);
    };

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit,
          ...idle,
          inspect: occupyOriginalWhileRestoring(fixture, result.manifestPath),
        },
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_UNDO_PARTIAL" });

    const persisted = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    expect(persisted.status).toBe("partial");
    expect(persisted.diagnostic).toMatchObject({
      code: "QUARANTINE_UNDO_PARTIAL",
      message: "undo failed and rollback was incomplete: injected relock failure",
    });
    expect(await missing(result.quarantinePath)).toBe(false);
  });
});
