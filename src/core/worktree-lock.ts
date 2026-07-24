import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { renameNoReplace } from "./no-clobber-rename.js";

export class WorktreeLockOwnershipError extends Error {
  override readonly name = "WorktreeLockOwnershipError";
}

export type OwnedWorktreeLock = {
  worktreePath: string;
  repositoryCommonDir: string;
  expectedReason: string;
  claimId: string;
  runGit: (args: string[]) => Promise<string>;
  platform?: NodeJS.Platform;
};

type LockPaths = {
  lockPath: string;
  claimPath: string;
};

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function resolveLockPaths(options: OwnedWorktreeLock): Promise<LockPaths> {
  const reportedPath = (
    await options.runGit(["-C", options.worktreePath, "rev-parse", "--git-path", "locked"])
  ).trim();
  if (reportedPath === "") {
    throw new WorktreeLockOwnershipError("Git returned an empty worktree lock path");
  }
  const lockPath = resolve(options.worktreePath, reportedPath);
  const commonDir = resolve(options.repositoryCommonDir);
  const relativePath = relative(commonDir, lockPath);
  if (
    basename(lockPath) !== "locked" ||
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new WorktreeLockOwnershipError("Git worktree lock path escaped the repository");
  }
  const [physicalCommonDir, physicalLockParent] = await Promise.all([
    realpath(commonDir),
    realpath(dirname(lockPath)),
  ]);
  const physicalRelativePath = relative(physicalCommonDir, physicalLockParent);
  if (
    physicalRelativePath === "" ||
    physicalRelativePath === ".." ||
    physicalRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(physicalRelativePath)
  ) {
    throw new WorktreeLockOwnershipError(
      "Git worktree lock path physically escaped the repository",
    );
  }
  const suffix = createHash("sha256").update(options.claimId).digest("hex").slice(0, 16);
  return {
    lockPath,
    claimPath: `${lockPath}.agentrinse-${suffix}`,
  };
}

async function assertOwnedClaim(path: string, expectedReason: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new WorktreeLockOwnershipError("captured Git worktree lock is not a regular file");
  }
  const reason = (await readFile(path, "utf8")).trim();
  if (reason !== expectedReason) {
    throw new WorktreeLockOwnershipError("Git worktree lock ownership changed before unlock");
  }
}

async function restoreClaim(paths: LockPaths, platform: NodeJS.Platform): Promise<void> {
  if (!(await pathExists(paths.claimPath)) || (await pathExists(paths.lockPath))) {
    return;
  }
  await renameNoReplace(paths.claimPath, paths.lockPath, platform);
}

async function retainClaim(
  paths: LockPaths,
  expectedReason: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const retainedPath = `${paths.lockPath}.agentrinse-released-${randomUUID()}`;
  await renameNoReplace(paths.claimPath, retainedPath, platform);
  try {
    await assertOwnedClaim(retainedPath, expectedReason);
  } catch (error) {
    if (!(await pathExists(paths.lockPath))) {
      await renameNoReplace(retainedPath, paths.lockPath, platform).catch(() => undefined);
    }
    throw error;
  }
}

async function reconcilePaths(
  paths: LockPaths,
  expectedReason: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!(await pathExists(paths.claimPath))) {
    return;
  }
  await assertOwnedClaim(paths.claimPath, expectedReason);
  if (!(await pathExists(paths.lockPath))) {
    await renameNoReplace(paths.claimPath, paths.lockPath, platform);
    return;
  }
  await retainClaim(paths, expectedReason, platform);
}

export async function reconcileOwnedWorktreeLockClaim(options: OwnedWorktreeLock): Promise<void> {
  const paths = await resolveLockPaths(options);
  await reconcilePaths(paths, options.expectedReason, options.platform ?? process.platform);
}

export async function lockOwnedWorktree(options: OwnedWorktreeLock): Promise<void> {
  const platform = options.platform ?? process.platform;
  const paths = await resolveLockPaths(options);
  await reconcilePaths(paths, options.expectedReason, platform);
  if (await pathExists(paths.lockPath)) {
    await assertOwnedClaim(paths.lockPath, options.expectedReason);
    return;
  }
  await options.runGit([
    "--git-dir",
    options.repositoryCommonDir,
    "worktree",
    "lock",
    "--reason",
    options.expectedReason,
    options.worktreePath,
  ]);
  await assertOwnedClaim(paths.lockPath, options.expectedReason);
}

export async function unlockOwnedWorktree(options: OwnedWorktreeLock): Promise<void> {
  const platform = options.platform ?? process.platform;
  const paths = await resolveLockPaths(options);
  await reconcilePaths(paths, options.expectedReason, platform);
  await renameNoReplace(paths.lockPath, paths.claimPath, platform);
  try {
    await assertOwnedClaim(paths.claimPath, options.expectedReason);
    await retainClaim(paths, options.expectedReason, platform);
  } catch (error) {
    await restoreClaim(paths, platform).catch(() => undefined);
    throw error;
  }
}
