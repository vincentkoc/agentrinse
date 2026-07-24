import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { readJsonFile } from "../../src/state/json-file.js";

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
  await execFileAsync("git", ["-C", main, "add", "README.md"]);
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
});

describe("worktree quarantine recovery", () => {
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
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    const restored = await undoWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      maxEntries: 10_000,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(restored.status).toBe("restored");
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

  it("purges an expired unchanged entry through clean Git removal", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const calls: string[][] = [];
    const runGit = async (args: string[]) => {
      calls.push(args);
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
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    const purged = await purgeWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      maxEntries: 10_000,
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
        maxEntries: 10_000,
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
});
