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
