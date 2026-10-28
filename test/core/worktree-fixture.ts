import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import type { WorktreeQuarantineAction } from "../../src/contracts/action.js";
import { quarantineEntrySchema } from "../../src/contracts/quarantine.js";
import { executeWorktreeQuarantine } from "../../src/core/worktree-executor.js";
import type { WorktreeRecoveryDependencies } from "../../src/core/worktree-recovery.js";
import { readJsonFile } from "../../src/state/json-file.js";

export const execFileAsync = promisify(execFile);

export type Fixture = {
  action: WorktreeQuarantineAction;
  home: string;
  linked: string;
  main: string;
  runGit: (args: string[]) => Promise<string>;
};

export async function gitFixture(): Promise<Fixture> {
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

export async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

export const idle: Pick<WorktreeRecoveryDependencies, "processProbe" | "mountProbe"> = {
  processProbe: async () => ({ status: "idle", matches: [] }),
  mountProbe: async () => ({ status: "clear", paths: [] }),
};

export async function quarantined(fixture: Fixture, id: string) {
  const quarantineDirectory = join(fixture.home, "state", "quarantine");
  const result = await executeWorktreeQuarantine(fixture.action, {
    runId: `run-${id}`,
    entryId: `entry-${id}`,
    quarantineDirectory,
    dependencies: { runGit: fixture.runGit },
  });
  const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
  return { quarantineDirectory, result, manifest };
}

export async function persistedStatus(manifestPath: string): Promise<string> {
  return quarantineEntrySchema.parse(await readJsonFile(manifestPath)).status;
}

export async function lockReason(fixture: Fixture, path: string): Promise<string | undefined> {
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
  const locked = records.find((record) => record.path === path)?.locked;
  return typeof locked === "string" ? locked : undefined;
}

export function occupyOriginalWhileRestoring(fixture: Fixture, manifestPath: string) {
  let occupied = false;
  return async (path: string) => {
    if (!occupied && path === fixture.linked) {
      const status = quarantineEntrySchema.parse(await readJsonFile(manifestPath)).status;
      if (status === "restoring") {
        occupied = true;
        await mkdir(path);
        await writeFile(join(path, "occupant.txt"), "arrived during undo\n");
      }
    }
    return lstat(path);
  };
}
