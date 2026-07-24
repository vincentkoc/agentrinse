import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import { renameNoReplace } from "../../src/core/no-clobber-rename.js";
import {
  reconcileOwnedWorktreeLockClaim,
  unlockOwnedWorktree,
  WorktreeLockOwnershipError,
} from "../../src/core/worktree-lock.js";

const execFileAsync = promisify(execFile);

async function lockFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-worktree-lock-")));
  const main = join(root, "repo");
  const linked = join(root, "task");
  await execFileAsync("git", ["init", "-b", "main", main]);
  await execFileAsync("git", ["-C", main, "config", "user.email", "fixture@example.test"]);
  await execFileAsync("git", ["-C", main, "config", "user.name", "AgentRinse Fixture"]);
  await writeFile(join(main, "README.md"), "fixture\n");
  await execFileAsync("git", ["-C", main, "add", "README.md"]);
  await execFileAsync("git", ["-C", main, "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", main, "worktree", "add", "-b", "task", linked]);
  const runGit = async (args: string[]) =>
    (
      await execFileAsync("git", args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const repositoryCommonDir = resolve(
    main,
    (await runGit(["-C", main, "rev-parse", "--git-common-dir"])).trim(),
  );
  return { linked, repositoryCommonDir, root, runGit };
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

describe("owned worktree lock handoff", () => {
  it("rejects a lock path redirected outside the Git common directory", async () => {
    const fixture = await lockFixture();
    const expectedReason = "AgentRinse quarantine entry-lock-symlink";
    await fixture.runGit([
      "--git-dir",
      fixture.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      expectedReason,
      fixture.linked,
    ]);
    const lockPath = (
      await fixture.runGit(["-C", fixture.linked, "rev-parse", "--git-path", "locked"])
    ).trim();
    const adminDirectory = dirname(lockPath);
    const externalAdminDirectory = join(fixture.root, "external-worktree-admin");
    await rename(adminDirectory, externalAdminDirectory);
    await symlink(externalAdminDirectory, adminDirectory);
    const runGit = async (args: string[]) =>
      args.includes("--git-path") && args.includes("locked")
        ? `${lockPath}\n`
        : fixture.runGit(args);

    await expect(
      unlockOwnedWorktree({
        worktreePath: fixture.linked,
        repositoryCommonDir: fixture.repositoryCommonDir,
        expectedReason,
        claimId: "entry-lock-symlink",
        runGit,
      }),
    ).rejects.toThrow("physically escaped");

    expect((await readFile(join(externalAdminDirectory, "locked"), "utf8")).trim()).toBe(
      expectedReason,
    );
  });

  it("restores a foreign lock swapped in after path lookup", async () => {
    const fixture = await lockFixture();
    const expectedReason = "AgentRinse quarantine entry-lock-race";
    await fixture.runGit([
      "--git-dir",
      fixture.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      expectedReason,
      fixture.linked,
    ]);
    let swapped = false;
    const runGit = async (args: string[]) => {
      const output = await fixture.runGit(args);
      if (!swapped && args.includes("--git-path") && args.includes("locked")) {
        swapped = true;
        await fixture.runGit([
          "--git-dir",
          fixture.repositoryCommonDir,
          "worktree",
          "unlock",
          fixture.linked,
        ]);
        await fixture.runGit([
          "--git-dir",
          fixture.repositoryCommonDir,
          "worktree",
          "lock",
          "--reason",
          "operator hold",
          fixture.linked,
        ]);
      }
      return output;
    };

    await expect(
      unlockOwnedWorktree({
        worktreePath: fixture.linked,
        repositoryCommonDir: fixture.repositoryCommonDir,
        expectedReason,
        claimId: "entry-lock-race",
        runGit,
      }),
    ).rejects.toBeInstanceOf(WorktreeLockOwnershipError);

    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: fixture.linked, locked: "operator hold" }),
      ]),
    );
  });

  it("restores an interrupted claim before later validation", async () => {
    const fixture = await lockFixture();
    const claimId = "entry-lock-recovery";
    const expectedReason = `AgentRinse quarantine ${claimId}`;
    await fixture.runGit([
      "--git-dir",
      fixture.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      expectedReason,
      fixture.linked,
    ]);
    const lockPath = (
      await fixture.runGit(["-C", fixture.linked, "rev-parse", "--git-path", "locked"])
    ).trim();
    const suffix = createHash("sha256").update(claimId).digest("hex").slice(0, 16);
    const claimPath = `${lockPath}.agentrinse-${suffix}`;
    await renameNoReplace(lockPath, claimPath);

    await reconcileOwnedWorktreeLockClaim({
      worktreePath: fixture.linked,
      repositoryCommonDir: fixture.repositoryCommonDir,
      expectedReason,
      claimId,
      runGit: fixture.runGit,
    });

    expect((await readFile(lockPath, "utf8")).trim()).toBe(expectedReason);
    expect(await missing(claimPath)).toBe(true);
  });
});
