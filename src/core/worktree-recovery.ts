import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import { parseGitStatusPorcelainV2 } from "../adapters/git/status.js";
import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { writeJsonAtomic } from "../state/json-file.js";
import { measurePath, type Measurement } from "./measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "./mount-boundaries.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";

const execFileAsync = promisify(execFile);

export class WorktreeRecoveryError extends Error {
  override readonly name = "WorktreeRecoveryError";

  constructor(
    readonly code: string,
    message: string,
    readonly entry: QuarantineEntry,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type WorktreeRecoveryDependencies = {
  runGit?: (args: string[]) => Promise<string>;
  inspect?: (path: string) => Promise<Stats>;
  move?: (source: string, destination: string) => Promise<void>;
  measure?: (path: string, options: { maxEntries: number }) => Promise<Measurement>;
  processProbe?: (path: string) => Promise<ProcessOwnershipResult>;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
  clock?: () => Date;
  platform?: NodeJS.Platform;
};

export type WorktreeRecoveryOptions = {
  manifestPath: string;
  quarantineDirectory: string;
  maxEntries: number;
  dependencies?: WorktreeRecoveryDependencies;
};

export type PurgeWorktreeOptions = WorktreeRecoveryOptions & {
  allowUnexpired?: boolean;
};

async function defaultGitRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(
  path: string,
  inspect: (path: string) => Promise<Stats>,
): Promise<boolean> {
  try {
    await inspect(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function branchRef(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function assertManifestPath(entry: QuarantineEntry, options: WorktreeRecoveryOptions): void {
  const expected = resolve(options.quarantineDirectory, `${entry.entryId}.json`);
  if (resolve(options.manifestPath) !== expected) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_MANIFEST_PATH_MISMATCH",
      "quarantine manifest filename does not match its entry ID",
      entry,
    );
  }
}

function registrationMatches(
  output: string,
  path: string,
  entry: QuarantineEntry,
  requireLocked: boolean,
): boolean {
  return parseWorktreePorcelain(output).some(
    (record) =>
      record.path === path &&
      record.head === entry.target.head &&
      record.branch === entry.target.branch &&
      (!requireLocked || record.locked !== undefined),
  );
}

async function persist(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  const parsed = quarantineEntrySchema.parse(entry);
  assertManifestPath(parsed, options);
  await writeJsonAtomic(options.manifestPath, parsed, {
    privateDirectories: [options.quarantineDirectory],
  });
  return parsed;
}

async function validateQuarantinedEntry(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
  requireOriginalVacant: boolean,
): Promise<{
  dependencies: Required<
    Pick<
      WorktreeRecoveryDependencies,
      "runGit" | "inspect" | "move" | "measure" | "processProbe" | "mountProbe" | "clock"
    >
  >;
}> {
  const dependencies = {
    runGit: options.dependencies?.runGit ?? defaultGitRunner,
    inspect: options.dependencies?.inspect ?? lstat,
    move:
      options.dependencies?.move ??
      ((source: string, destination: string) =>
        renameNoReplace(source, destination, options.dependencies?.platform ?? process.platform)),
    measure: options.dependencies?.measure ?? measurePath,
    processProbe: options.dependencies?.processProbe ?? findProcessesUsingPath,
    mountProbe: options.dependencies?.mountProbe ?? findMountBoundaries,
    clock: options.dependencies?.clock ?? (() => new Date()),
  };
  const fail = (code: string, message: string): never => {
    throw new WorktreeRecoveryError(code, message, entry);
  };

  const platform = options.dependencies?.platform ?? process.platform;
  if (!["darwin", "linux"].includes(platform)) {
    fail(
      "WORKTREE_PLATFORM_UNSUPPORTED",
      `worktree recovery mutation is unsupported on ${platform}`,
    );
  }
  if (entry.status !== "quarantined") {
    fail("QUARANTINE_NOT_LIVE", `quarantine entry status is ${entry.status}`);
  }
  assertManifestPath(entry, options);
  const quarantineIdentity =
    entry.quarantineIdentity ??
    fail("QUARANTINE_IDENTITY_MISSING", "post-repair quarantine identity is missing");
  if (requireOriginalVacant && (await pathExists(entry.originalPath, dependencies.inspect))) {
    fail("UNDO_DESTINATION_OCCUPIED", `original path is occupied: ${entry.originalPath}`);
  }

  const [quarantineStats, commonDirStats] = await Promise.all([
    dependencies.inspect(entry.quarantinePath),
    dependencies.inspect(entry.target.repositoryCommonDir),
  ]);
  if (
    !quarantineStats.isDirectory() ||
    quarantineStats.isSymbolicLink() ||
    quarantineStats.dev !== quarantineIdentity.device ||
    quarantineStats.ino !== quarantineIdentity.inode ||
    quarantineStats.mtimeMs !== quarantineIdentity.mtimeMs
  ) {
    fail("QUARANTINE_IDENTITY_CHANGED", "quarantined worktree filesystem identity changed");
  }
  if (!commonDirStats.isDirectory() || commonDirStats.isSymbolicLink()) {
    fail("QUARANTINE_REPOSITORY_CHANGED", "Git common directory is no longer a real directory");
  }

  const measurement = await dependencies.measure(entry.quarantinePath, {
    maxEntries: options.maxEntries,
  });
  if (
    measurement.truncated ||
    measurement.specialEntries > 0 ||
    measurement.mountBoundaries > 0 ||
    measurement.bytes !== quarantineIdentity.measuredBytes ||
    measurement.newestMtimeMs !== quarantineIdentity.newestMtimeMs ||
    measurement.fingerprint !== quarantineIdentity.fingerprint
  ) {
    fail("QUARANTINE_CONTENT_CHANGED", "quarantined worktree contents changed after apply");
  }
  const ownership = await dependencies.processProbe(entry.quarantinePath);
  if (ownership.status !== "idle") {
    fail(
      ownership.status === "busy" ? "QUARANTINE_PROCESS_ACTIVE" : "QUARANTINE_PROCESS_UNKNOWN",
      ownership.status === "busy"
        ? "a live process owns the quarantined worktree"
        : "live process ownership could not be proven idle",
    );
  }
  const mounts = await dependencies.mountProbe(entry.quarantinePath);
  if (mounts.status !== "clear") {
    fail(
      mounts.status === "blocked"
        ? "QUARANTINE_MOUNT_BOUNDARY"
        : "QUARANTINE_MOUNT_INSPECTION_UNKNOWN",
      mounts.status === "blocked"
        ? "quarantined worktree contains a mount boundary"
        : "mount boundaries could not be proven absent",
    );
  }

  const status = parseGitStatusPorcelainV2(
    await dependencies.runGit([
      "-C",
      entry.quarantinePath,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]),
  );
  if (
    status.head !== entry.target.head ||
    branchRef(status.branch) !== entry.target.branch ||
    status.staged + status.modified + status.untracked + status.conflicted > 0
  ) {
    fail("QUARANTINE_GIT_STATE_CHANGED", "quarantined worktree is no longer clean at planned HEAD");
  }
  const records = await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (!registrationMatches(records, entry.quarantinePath, entry, true)) {
    fail(
      "QUARANTINE_REGISTRATION_CHANGED",
      "quarantined worktree is no longer registered and locked",
    );
  }
  const recoveryHead = (
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "rev-parse",
      "--verify",
      entry.recoveryRef,
    ])
  ).trim();
  if (recoveryHead !== entry.target.head) {
    fail("QUARANTINE_RECOVERY_REF_CHANGED", "recovery ref no longer points to the planned HEAD");
  }

  return { dependencies };
}

export async function undoWorktreeQuarantine(
  input: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  let entry = quarantineEntrySchema.parse(input);
  const { dependencies } = await validateQuarantinedEntry(entry, options, true);
  entry = await persist({ ...entry, status: "restoring" }, options);
  let unlocked = false;
  let moved = false;

  try {
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "unlock",
      entry.quarantinePath,
    ]);
    unlocked = true;
    if (await pathExists(entry.originalPath, dependencies.inspect)) {
      throw new Error(`original path became occupied before undo: ${entry.originalPath}`);
    }
    await dependencies.move(entry.quarantinePath, entry.originalPath);
    moved = true;
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "repair",
      entry.originalPath,
    ]);
    const records = await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!registrationMatches(records, entry.originalPath, entry, false)) {
      throw new Error("restored worktree registration could not be verified");
    }
    const status = parseGitStatusPorcelainV2(
      await dependencies.runGit([
        "-C",
        entry.originalPath,
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
      ]),
    );
    if (
      status.head !== entry.target.head ||
      branchRef(status.branch) !== entry.target.branch ||
      status.staged + status.modified + status.untracked + status.conflicted > 0
    ) {
      throw new Error("restored worktree Git state could not be verified");
    }
    entry = await persist(
      {
        ...entry,
        status: "restored",
        restoredAt: dependencies.clock().toISOString(),
      },
      options,
    );
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "update-ref",
      "-d",
      entry.recoveryRef,
      entry.target.head,
    ]);
    return entry;
  } catch (error) {
    try {
      if (moved) {
        if (
          (await pathExists(entry.quarantinePath, dependencies.inspect)) ||
          !(await pathExists(entry.originalPath, dependencies.inspect))
        ) {
          throw new Error("worktree paths are not safe for undo rollback");
        }
        await dependencies.move(entry.originalPath, entry.quarantinePath);
        await dependencies.runGit([
          "--git-dir",
          entry.target.repositoryCommonDir,
          "worktree",
          "repair",
          entry.quarantinePath,
        ]);
      }
      if (unlocked) {
        await dependencies.runGit([
          "--git-dir",
          entry.target.repositoryCommonDir,
          "worktree",
          "lock",
          "--reason",
          `AgentRinse quarantine ${entry.entryId}`,
          entry.quarantinePath,
        ]);
      }
      entry = await persist(
        {
          ...entry,
          status: "quarantined",
          diagnostic: {
            severity: "error",
            code: "QUARANTINE_UNDO_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: "git",
            resourceId: entry.resourceId,
          },
        },
        options,
      );
      throw new WorktreeRecoveryError(
        "QUARANTINE_UNDO_FAILED",
        "undo failed and the quarantine entry was restored",
        entry,
        { cause: error },
      );
    } catch (rollbackError) {
      if (rollbackError instanceof WorktreeRecoveryError && rollbackError.cause === error) {
        throw rollbackError;
      }
      entry = await persist(
        {
          ...entry,
          status: "partial",
          diagnostic: {
            severity: "error",
            code: "QUARANTINE_UNDO_PARTIAL",
            message: `undo failed and rollback was incomplete: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
            adapter: "git",
            resourceId: entry.resourceId,
          },
        },
        options,
      ).catch(() => entry);
      throw new WorktreeRecoveryError(
        "QUARANTINE_UNDO_PARTIAL",
        `undo left partial state; inspect ${options.manifestPath}`,
        entry,
        { cause: rollbackError },
      );
    }
  }
}

export async function purgeWorktreeQuarantine(
  input: QuarantineEntry,
  options: PurgeWorktreeOptions,
): Promise<{ entry: QuarantineEntry; reclaimedBytes: number }> {
  let entry = quarantineEntrySchema.parse(input);
  const { dependencies } = await validateQuarantinedEntry(entry, options, false);
  if (
    options.allowUnexpired !== true &&
    dependencies.clock().getTime() < Date.parse(entry.expiresAt)
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_NOT_EXPIRED",
      `quarantine entry does not expire until ${entry.expiresAt}`,
      entry,
    );
  }
  entry = await persist({ ...entry, status: "purging" }, options);
  let unlocked = false;

  try {
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "unlock",
      entry.quarantinePath,
    ]);
    unlocked = true;
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "remove",
      entry.quarantinePath,
    ]);
    if (await pathExists(entry.quarantinePath, dependencies.inspect)) {
      throw new Error("Git reported success but the quarantine path still exists");
    }
    const records = await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (parseWorktreePorcelain(records).some((record) => record.path === entry.quarantinePath)) {
      throw new Error("Git reported success but the quarantine registration remains");
    }
    entry = await persist(
      {
        ...entry,
        status: "purged",
        purgedAt: dependencies.clock().toISOString(),
      },
      options,
    );
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "update-ref",
      "-d",
      entry.recoveryRef,
      entry.target.head,
    ]);
    return { entry, reclaimedBytes: entry.target.measuredBytes };
  } catch (error) {
    try {
      if (await pathExists(entry.quarantinePath, dependencies.inspect)) {
        if (unlocked) {
          await dependencies.runGit([
            "--git-dir",
            entry.target.repositoryCommonDir,
            "worktree",
            "lock",
            "--reason",
            `AgentRinse quarantine ${entry.entryId}`,
            entry.quarantinePath,
          ]);
        }
        entry = await persist(
          {
            ...entry,
            status: "quarantined",
            diagnostic: {
              severity: "error",
              code: "QUARANTINE_PURGE_FAILED",
              message: error instanceof Error ? error.message : String(error),
              adapter: "git",
              resourceId: entry.resourceId,
            },
          },
          options,
        );
        throw new WorktreeRecoveryError(
          "QUARANTINE_PURGE_FAILED",
          unlocked
            ? "purge failed and the quarantine entry was relocked"
            : "purge failed before mutation and the quarantine entry remains retryable",
          entry,
          { cause: error },
        );
      }
      throw error;
    } catch (recoveryError) {
      if (recoveryError instanceof WorktreeRecoveryError && recoveryError.cause === error) {
        throw recoveryError;
      }
      entry = await persist(
        {
          ...entry,
          status: "partial",
          diagnostic: {
            severity: "error",
            code: "QUARANTINE_PURGE_PARTIAL",
            message: `purge left partial state: ${
              recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
            }`,
            adapter: "git",
            resourceId: entry.resourceId,
          },
        },
        options,
      ).catch(() => entry);
      throw new WorktreeRecoveryError(
        "QUARANTINE_PURGE_PARTIAL",
        `purge left partial state; inspect ${options.manifestPath}`,
        entry,
        { cause: recoveryError },
      );
    }
  }
}
