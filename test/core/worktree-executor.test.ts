import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import type { WorktreeQuarantineAction } from "../../src/contracts/action.js";
import { quarantineEntrySchema } from "../../src/contracts/quarantine.js";
import {
  executeWorktreeQuarantine,
  WorktreeExecutionError,
  worktreeQuarantinePath,
  worktreeRecoveryRef,
} from "../../src/core/worktree-executor.js";
import {
  purgeWorktreeQuarantine,
  undoWorktreeQuarantine,
} from "../../src/core/worktree-recovery.js";
import { measurePath } from "../../src/core/measure.js";
import { renameNoReplace } from "../../src/core/no-clobber-rename.js";
import { readJsonFile, writeJsonAtomic } from "../../src/state/json-file.js";

const execFileAsync = promisify(execFile);

type Fixture = {
  action: WorktreeQuarantineAction;
  home: string;
  linked: string;
  main: string;
  runGit: (args: string[]) => Promise<string>;
};

async function gitFixture(): Promise<Fixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-worktree-executor-")));
  const main = join(home, "repo");
  const linked = join(home, "task");
  const remote = join(home, "remote.git");
  await execFileAsync("git", ["init", "--bare", remote]);
  await execFileAsync("git", ["init", "-b", "main", main]);
  await execFileAsync("git", ["-C", main, "config", "user.email", "fixture@example.test"]);
  await execFileAsync("git", ["-C", main, "config", "user.name", "AgentRinse Fixture"]);
  await writeFile(join(main, "README.md"), "fixture\n");
  await writeFile(join(main, ".gitignore"), ".env\n");
  await execFileAsync("git", ["-C", main, "add", "README.md", ".gitignore"]);
  await execFileAsync("git", ["-C", main, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", main, "remote", "add", "origin", remote]);
  await execFileAsync("git", ["-C", main, "push", "-u", "origin", "main"]);
  await execFileAsync("git", ["-C", main, "branch", "task"]);
  await execFileAsync("git", ["-C", main, "push", "-u", "origin", "task"]);
  await execFileAsync("git", ["-C", main, "worktree", "add", linked, "task"]);

  const runGit = async (args: string[]) =>
    (
      await execFileAsync("git", args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const adapter = new GitWorktreeAuditAdapter(
    main,
    runGit,
    undefined,
    async () => ({ status: "idle", matches: [] }),
    undefined,
    {
      maxEntries: 10_000,
      measureBytes: true,
      minAgeMinutes: 0,
      quarantineTtlMinutes: 60,
      platform: process.platform === "linux" ? "linux" : "darwin",
    },
    {
      mountProbe: async () => ({ status: "clear", paths: [] }),
    },
  );
  const context: AuditContext = {
    home,
    now: new Date(),
    auditId: "audit-executor",
  };
  const collection = await adapter.collect(context, await adapter.probe(context));
  const resource = collection.resources.find((candidate) => candidate.facts.isMain === false);
  if (resource === undefined) {
    throw new Error("linked worktree fixture was not discovered");
  }
  const finding = await adapter.classify(context, resource);
  const action = finding.candidateActions[0];
  if (action?.type !== "worktree.quarantine") {
    throw new Error("linked worktree fixture was not eligible");
  }
  return { action, home, linked: action.target.path, main, runGit };
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

describe("executeWorktreeQuarantine", () => {
  it("moves, repairs, locks, and journals a linked worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const runId = "run-fixture";
    const entryId = "entry-fixture";

    const result = await executeWorktreeQuarantine(fixture.action, {
      runId,
      entryId,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(await missing(fixture.linked)).toBe(true);
    expect(await missing(result.quarantinePath)).toBe(false);
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
          path: result.quarantinePath,
          head: fixture.action.target.head,
          branch: fixture.action.target.branch,
          locked: `AgentRinse quarantine ${entryId}`,
        }),
      ]),
    );
    expect(
      (
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "rev-parse",
          "--verify",
          worktreeRecoveryRef(fixture.action, runId),
        ])
      ).trim(),
    ).toBe(fixture.action.target.head);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath))).toMatchObject({
      status: "quarantined",
      originalPath: fixture.linked,
      quarantinePath: result.quarantinePath,
    });
    expect(result.quarantinedBytes).toBe(fixture.action.target.measuredBytes);
  });

  it("rejects a worktree that occupies the reserved quarantine container", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const action = {
      ...fixture.action,
      target: {
        ...fixture.action.target,
        path: join(dirname(fixture.linked), ".agentrinse-quarantine"),
      },
    };

    await expect(
      executeWorktreeQuarantine(action, {
        runId: "run-reserved-path",
        entryId: "entry-reserved-path",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "QUARANTINE_PATH_CONFLICT",
    });
  });

  it("rejects a Git operation that starts after audit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const markerPath = (
      await fixture.runGit(["-C", fixture.linked, "rev-parse", "--git-path", "MERGE_HEAD"])
    ).trim();
    await writeFile(markerPath, `${fixture.action.target.head}\n`);

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-operation-race",
        entryId: "entry-operation-race",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "GIT_OPERATION_IN_PROGRESS",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, "entry-operation-race"))).toBe(
      true,
    );
  });

  it("does not repair a registration moved to a third path during quarantine", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-third-registration";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const thirdPath = join(fixture.home, "third-registration");

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-third-registration",
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          move: async (source, destination) => {
            await renameNoReplace(source, thirdPath);
            await fixture.runGit([
              "--git-dir",
              fixture.action.target.repositoryCommonDir,
              "worktree",
              "repair",
              thirdPath,
            ]);
            await renameNoReplace(thirdPath, destination);
          },
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "partially-applied",
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
          path: thirdPath,
          head: fixture.action.target.head,
        }),
      ]),
    );
  });

  it("restores the original worktree when Git locking fails", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-rollback";
    const runId = "run-rollback";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const runGit = async (args: string[]) => {
      if (args.includes("lock")) {
        throw new Error("injected lock failure");
      }
      if (args.includes("update-ref") && args.includes("-d")) {
        const persisted = quarantineEntrySchema.parse(
          await readJsonFile(join(quarantineDirectory, `${entryId}.json`)),
        );
        expect(persisted.status).toBe("moved");
      }
      return fixture.runGit(args);
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: { runGit },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "rolled-back",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(quarantinePath)).toBe(true);
    const manifest = quarantineEntrySchema.parse(
      await readJsonFile(join(quarantineDirectory, `${entryId}.json`)),
    );
    expect(manifest.status).toBe("restored");
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("keeps rollback recoverable when recovery ref deletion fails", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-rollback-ref";
    const runId = "run-rollback-ref";
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    let failRefDeletion = true;
    const runGit = async (args: string[]) => {
      if (args.includes("lock")) {
        throw new Error("injected lock failure");
      }
      if (args.includes("update-ref") && args.includes("-d") && failRefDeletion) {
        failRefDeletion = false;
        throw new Error("injected ref deletion failure");
      }
      return fixture.runGit(args);
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: { runGit },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "partially-applied",
      diagnosticCode: "WORKTREE_ROLLBACK_FINALIZE_PENDING",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, entryId))).toBe(true);
    const interrupted = quarantineEntrySchema.parse(await readJsonFile(manifestPath));
    expect(interrupted.status).toBe("moved");

    const restored = await undoWorktreeQuarantine(interrupted, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("rolls back when contents race after the atomic move", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-race",
        entryId: "entry-race",
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          move: async (source, destination) => {
            await rename(source, destination);
            if (source === fixture.action.target.path) {
              await writeFile(join(destination, "README.md"), "changed fixture!\n");
            }
          },
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "rolled-back",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await readFile(join(fixture.linked, "README.md"), "utf8")).toBe("changed fixture!\n");
  });

  it("stops when a process acquires the worktree at the mutation boundary", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-process-race";
    const runId = "run-process-race";

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({
            status: "busy",
            matches: [{ pid: 123, source: "cwd", path: fixture.linked }],
          }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "skipped-stale",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, entryId))).toBe(true);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("stops when the Git index changes after the earlier audit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    let injected = false;
    const runGit = async (args: string[]) => {
      const output = await fixture.runGit(args);
      if (args.includes("update-ref") && !args.includes("-d") && !injected) {
        injected = true;
        const blob = (
          await fixture.runGit(["-C", fixture.linked, "rev-parse", "HEAD:README.md"])
        ).trim();
        await fixture.runGit([
          "-C",
          fixture.linked,
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blob},INDEX_ONLY.txt`,
        ]);
      }
      return output;
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-index-race",
        entryId: "entry-index-race",
        quarantineDirectory,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "skipped-stale",
    });

    expect(await missing(fixture.linked)).toBe(false);
  });

  it("rolls back when a process acquires the quarantined path before commit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    let probeCount = 0;

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-final-process-race",
        entryId: "entry-final-process-race",
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () =>
            ++probeCount === 1
              ? { status: "idle", matches: [] }
              : {
                  status: "busy",
                  matches: [{ pid: 456, source: "cwd", path: fixture.linked }],
                },
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "rolled-back",
    });

    expect(await missing(fixture.linked)).toBe(false);
  });
});

describe("worktree quarantine recovery", () => {
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

  it("refuses undo and purge after a foreign worktree lock replaces its lock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-foreign-lock",
      entryId: "entry-foreign-lock",
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
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      "operator hold",
      result.quarantinePath,
    ]);

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
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
    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

    expect(await missing(result.quarantinePath)).toBe(false);
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
          path: result.quarantinePath,
          locked: "operator hold",
        }),
      ]),
    );
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

  it("purges an expired unchanged entry through clean Git removal", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const calls: string[][] = [];
    let manifestPath: string | undefined;
    const runGit = async (args: string[]) => {
      calls.push(args);
      if (args.includes("update-ref") && args.includes("-d") && manifestPath !== undefined) {
        const persisted = quarantineEntrySchema.parse(await readJsonFile(manifestPath));
        expect(persisted.status).toBe("purging");
      }
      return fixture.runGit(args);
    };
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge",
      entryId: "entry-purge",
      quarantineDirectory,
      dependencies: {
        runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    manifestPath = result.manifestPath;
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await mkdir(fixture.linked);

    const purged = await purgeWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe(fixture.action.target.measuredBytes);
    expect(await missing(result.quarantinePath)).toBe(true);
    const removeCall = calls.find((args) => args.includes("worktree") && args.includes("remove"));
    expect(removeCall).toBeDefined();
    expect(removeCall).not.toContain("--force");
    expect(await missing(fixture.linked)).toBe(false);
  });

  it("refuses purge when a Git operation marker appears after quarantine", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-operation",
      entryId: "entry-purge-operation",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const markerPath = (
      await fixture.runGit(["-C", result.quarantinePath, "rev-parse", "--git-path", "rebase-apply"])
    ).trim();
    await mkdir(markerPath, { recursive: true });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_GIT_OPERATION_IN_PROGRESS",
    });

    expect(await missing(result.quarantinePath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("keeps an entry retryable when purge fails before unlock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-unlock",
      entryId: "entry-purge-unlock",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await mkdir(fixture.linked);
    await writeFile(join(fixture.linked, "replacement.txt"), "unrelated replacement\n");
    const purgingBeforeUnlock = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purgingBeforeUnlock, {
      privateDirectories: [quarantineDirectory],
    });
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("unlock")) {
        throw new Error("injected unlock failure");
      }
      return fixture.runGit(args);
    };

    await expect(
      purgeWorktreeQuarantine(purgingBeforeUnlock, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    const persisted = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    expect(persisted.status).toBe("quarantined");
    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(fixture.linked, "replacement.txt"), "utf8")).resolves.toBe(
      "unrelated replacement\n",
    );
  });

  it("rolls purge isolation back when ignored content appears before final validation", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-ignored-race",
      entryId: "entry-purge-ignored-race",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;
    let injected = false;
    const runGit = async (args: string[]) => {
      const output = await fixture.runGit(args);
      if (
        !injected &&
        args.includes("worktree") &&
        args.includes("repair") &&
        args.includes(isolationPath)
      ) {
        injected = true;
        await writeFile(join(isolationPath, ".env"), "arrived during purge\n");
      }
      return output;
    };

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(result.quarantinePath, ".env"), "utf8")).resolves.toBe(
      "arrived during purge\n",
    );
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("resumes purge from an atomically isolated worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge-isolated",
      entryId: "entry-resume-purge-isolated",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    const purged = await purgeWorktreeQuarantine(purging, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(await missing(isolationPath)).toBe(true);
  });

  it("checks Git operation markers before repairing isolated purge state", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-isolated-operation",
      entryId: "entry-purge-isolated-operation",
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
    const markerPath = (
      await fixture.runGit(["-C", isolationPath, "rev-parse", "--git-path", "rebase-apply"])
    ).trim();
    await mkdir(markerPath, { recursive: true });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
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

    expect(await missing(isolationPath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "purging",
    );
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
      expect.arrayContaining([expect.objectContaining({ path: result.quarantinePath })]),
    );
  });

  it("rolls an interrupted purge back when isolated validation fails", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge-rollback",
      entryId: "entry-resume-purge-rollback",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    await writeFile(join(isolationPath, "changed.txt"), "changed after crash\n");
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
          clock: () => new Date("2026-07-24T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(await missing(isolationPath)).toBe(true);
    expect(await missing(result.quarantinePath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
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
          path: result.quarantinePath,
          locked: "AgentRinse quarantine entry-resume-purge-rollback",
        }),
      ]),
    );
  });

  it("does not repair isolated purge state protected by a foreign lock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-isolated-lock",
      entryId: "entry-purge-isolated-lock",
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
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      "operator hold",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
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

    expect(await missing(isolationPath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "purging",
    );
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
          path: result.quarantinePath,
          locked: "operator hold",
        }),
      ]),
    );
  });

  it("refuses to finalize purge when the target registration moved elsewhere", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-third-path",
      entryId: "entry-purge-third-path",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const thirdPath = join(dirname(result.quarantinePath), "moved-by-operator");
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, thirdPath);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "repair",
      thirdPath,
    ]);
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

    expect(await missing(thirdPath)).toBe(false);
    expect(
      (
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "rev-parse",
          "--verify",
          result.recoveryRef,
        ])
      ).trim(),
    ).toBe(fixture.action.target.head);
  });

  it("finishes an interrupted purge after Git removed the worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge",
      entryId: "entry-resume-purge",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "remove",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      "-d",
      result.recoveryRef,
      fixture.action.target.head,
    ]);
    await mkdir(fixture.linked);
    await writeFile(join(fixture.linked, "replacement.txt"), "unrelated replacement\n");
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    const purged = await purgeWorktreeQuarantine(purging, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe(fixture.action.target.measuredBytes);
    await expect(readFile(join(fixture.linked, "replacement.txt"), "utf8")).resolves.toBe(
      "unrelated replacement\n",
    );
  });

  it("refuses purge after quarantined contents change", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-dirty",
      entryId: "entry-dirty",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    await writeFile(join(result.quarantinePath, "changed.txt"), "changed\n");
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
          clock: () => new Date("2026-07-24T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_IDENTITY_CHANGED",
    });
    expect(await missing(result.quarantinePath)).toBe(false);
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
});
