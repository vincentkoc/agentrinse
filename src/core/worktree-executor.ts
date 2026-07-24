import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import {
  countStatusSuppressedIndexEntries,
  parseGitStatusPorcelainV2,
} from "../adapters/git/status.js";
import type { WorktreeQuarantineAction } from "../contracts/action.js";
import {
  quarantineEntryIdSchema,
  quarantineEntrySchema,
  quarantineRecoveryRef,
  type QuarantineEntry,
} from "../contracts/quarantine.js";
import { ensurePrivateDirectory, writeJsonAtomic } from "../state/json-file.js";
import { findGitOperations } from "./git-operation-state.js";
import { measurePath, type Measurement, type MeasureOptions } from "./measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "./mount-boundaries.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";

const execFileAsync = promisify(execFile);

export type WorktreeExecutionOutcome =
  | "skipped-stale"
  | "failed"
  | "rolled-back"
  | "partially-applied";

export class WorktreeExecutionError extends Error {
  override readonly name = "WorktreeExecutionError";

  constructor(
    message: string,
    readonly outcome: WorktreeExecutionOutcome,
    readonly entry?: QuarantineEntry,
    options?: ErrorOptions & { diagnosticCode?: string; quarantinedBytes?: number },
  ) {
    super(message, options);
    this.diagnosticCode = options?.diagnosticCode;
    this.quarantinedBytes = options?.quarantinedBytes;
  }

  readonly diagnosticCode: string | undefined;
  readonly quarantinedBytes: number | undefined;
}

export type WorktreeExecutionResult = {
  quarantineEntryId: string;
  quarantinePath: string;
  recoveryRef: string;
  quarantinedBytes: number;
  manifestPath: string;
};

export type WorktreeExecutorDependencies = {
  runGit?: (args: string[]) => Promise<string>;
  inspect?: (path: string) => Promise<Stats>;
  move?: (source: string, destination: string) => Promise<void>;
  measure?: (path: string, options: MeasureOptions) => Promise<Measurement>;
  processProbe?: (path: string) => Promise<ProcessOwnershipResult>;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
  maxEntries?: number;
  clock?: () => Date;
  platform?: NodeJS.Platform;
  authorization?: {
    expiresAtMs: number;
    now: () => Date;
  };
};

export type ExecuteWorktreeQuarantineOptions = {
  runId: string;
  entryId: string;
  quarantineDirectory: string;
  dependencies?: WorktreeExecutorDependencies;
};

async function defaultGitRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
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

function matchesFilesystemIdentity(stats: Stats, action: WorktreeQuarantineAction): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.dev === action.target.device &&
    stats.ino === action.target.inode &&
    stats.mtimeMs === action.target.mtimeMs
  );
}

function branchRef(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function cleanStatusMatches(output: string, action: WorktreeQuarantineAction): boolean {
  const status = parseGitStatusPorcelainV2(output);
  return (
    status.head === action.target.head &&
    branchRef(status.branch) === action.target.branch &&
    status.staged + status.modified + status.untracked + status.conflicted + status.ignored === 0
  );
}

function assertAuthorized(
  authorization: WorktreeExecutorDependencies["authorization"],
  entry?: QuarantineEntry,
): void {
  if (authorization !== undefined && authorization.now().getTime() >= authorization.expiresAtMs) {
    throw new WorktreeExecutionError(
      "cleanup plan authorization expired before worktree quarantine",
      "skipped-stale",
      entry,
      { diagnosticCode: "PLAN_EXPIRED_DURING_APPLY" },
    );
  }
}

export function worktreeQuarantinePath(action: WorktreeQuarantineAction, entryId: string): string {
  return join(dirname(action.target.path), ".agentrinse-quarantine", entryId);
}

export function worktreeRecoveryRef(action: WorktreeQuarantineAction, runId: string): string {
  return quarantineRecoveryRef(runId, action.resourceId);
}

function worktreeLockReason(entryId: string): string {
  return `AgentRinse quarantine ${entryId}`;
}

function registeredWorktree(
  output: string,
  path: string,
  action: WorktreeQuarantineAction,
  expectedLockReason?: string,
): boolean {
  const expectedPath = resolve(path);
  return parseWorktreePorcelain(output).some(
    (record) =>
      resolve(record.path) === expectedPath &&
      record.head === action.target.head &&
      record.branch === action.target.branch &&
      record.locked === expectedLockReason,
  );
}

function targetRegistrationLockMatches(
  output: string,
  action: WorktreeQuarantineAction,
  expectedPath: string,
  expectedLockReason?: string,
): boolean {
  const records = parseWorktreePorcelain(output).filter(
    (record) => record.head === action.target.head && record.branch === action.target.branch,
  );
  return (
    records.length === 1 &&
    resolve(records[0]!.path) === resolve(expectedPath) &&
    records[0]?.locked === expectedLockReason
  );
}

function pathContains(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function assertNoGitOperations(
  worktreePath: string,
  entry: QuarantineEntry,
  runGit: (args: string[]) => Promise<string>,
  inspect: (path: string) => Promise<Stats>,
): Promise<void> {
  const operations = await findGitOperations(worktreePath, runGit, (path) =>
    pathExists(path, inspect),
  );
  if (operations.length > 0) {
    throw new WorktreeExecutionError(
      `Git operation started before quarantine: ${operations.join(", ")}`,
      "skipped-stale",
      entry,
      { diagnosticCode: "GIT_OPERATION_IN_PROGRESS" },
    );
  }
}

async function writeManifest(
  manifestPath: string,
  quarantineDirectory: string,
  entry: QuarantineEntry,
): Promise<QuarantineEntry> {
  const parsed = quarantineEntrySchema.parse(entry);
  await writeJsonAtomic(manifestPath, parsed, {
    privateDirectories: [quarantineDirectory],
  });
  return parsed;
}

export async function executeWorktreeQuarantine(
  action: WorktreeQuarantineAction,
  options: ExecuteWorktreeQuarantineOptions,
): Promise<WorktreeExecutionResult> {
  const dependencies = options.dependencies ?? {};
  const runGit = dependencies.runGit ?? defaultGitRunner;
  const inspect = dependencies.inspect ?? lstat;
  const platform = dependencies.platform ?? process.platform;
  const move =
    dependencies.move ?? ((source, destination) => renameNoReplace(source, destination, platform));
  const measure = dependencies.measure ?? measurePath;
  const processProbe = dependencies.processProbe ?? findProcessesUsingPath;
  const mountProbe = dependencies.mountProbe ?? findMountBoundaries;
  const clock = dependencies.clock ?? (() => new Date());
  if (!["darwin", "linux"].includes(platform)) {
    throw new WorktreeExecutionError(
      `worktree quarantine mutation is unsupported on ${platform}`,
      "failed",
      undefined,
      { diagnosticCode: "WORKTREE_PLATFORM_UNSUPPORTED" },
    );
  }
  const entryId = quarantineEntryIdSchema.parse(options.entryId);
  const quarantinePath = worktreeQuarantinePath(action, entryId);
  if (pathContains(action.target.path, quarantinePath)) {
    throw new WorktreeExecutionError(
      "worktree occupies AgentRinse's reserved quarantine container",
      "failed",
      undefined,
      { diagnosticCode: "QUARANTINE_PATH_CONFLICT" },
    );
  }
  const quarantineParent = dirname(quarantinePath);
  const recoveryRef = worktreeRecoveryRef(action, options.runId);
  const manifestPath = join(options.quarantineDirectory, `${entryId}.json`);
  const createdAt = clock();
  const measurementMaxEntries = dependencies.maxEntries ?? 100_000;
  let entry = quarantineEntrySchema.parse({
    schemaVersion: 1,
    entryId,
    runId: options.runId,
    actionId: action.actionId,
    resourceId: action.resourceId,
    status: "preparing",
    originalPath: action.target.path,
    quarantinePath,
    recoveryRef,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + action.quarantineTtlMinutes * 60_000).toISOString(),
    measurementMaxEntries,
    target: action.target,
  });
  let refCreated = false;
  let moved = false;
  let repaired = false;
  let locked = false;

  const initialRegistrations = parseWorktreePorcelain(
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]),
  );
  if (
    initialRegistrations.some(
      (registration) => resolve(registration.path) === resolve(quarantineParent),
    )
  ) {
    throw new WorktreeExecutionError(
      "quarantine container is itself a registered Git worktree",
      "failed",
      undefined,
      { diagnosticCode: "QUARANTINE_CONTAINER_WORKTREE" },
    );
  }
  await ensurePrivateDirectory(options.quarantineDirectory);
  await ensurePrivateDirectory(quarantineParent);
  entry = await writeManifest(manifestPath, options.quarantineDirectory, entry);

  try {
    const [targetStats, quarantineParentStats, commonDirStats] = await Promise.all([
      inspect(action.target.path),
      inspect(quarantineParent),
      inspect(action.target.repositoryCommonDir),
    ]);
    if (!matchesFilesystemIdentity(targetStats, action)) {
      throw new WorktreeExecutionError(
        "worktree filesystem identity changed before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (
      !quarantineParentStats.isDirectory() ||
      quarantineParentStats.isSymbolicLink() ||
      quarantineParentStats.dev !== targetStats.dev
    ) {
      throw new WorktreeExecutionError(
        "quarantine directory is not a real directory on the worktree filesystem",
        "failed",
        entry,
        { diagnosticCode: "QUARANTINE_CROSS_DEVICE" },
      );
    }
    if (!commonDirStats.isDirectory() || commonDirStats.isSymbolicLink()) {
      throw new WorktreeExecutionError(
        "Git common directory is no longer a real directory",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (await pathExists(quarantinePath, inspect)) {
      throw new WorktreeExecutionError(
        `refusing to overwrite existing quarantine path ${quarantinePath}`,
        "failed",
        entry,
      );
    }
    const before = await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!registeredWorktree(before, action.target.path, action)) {
      throw new WorktreeExecutionError(
        "Git worktree registration changed before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }

    assertAuthorized(dependencies.authorization, entry);
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      action.target.head,
      "",
    ]);
    refCreated = true;
    entry = await writeManifest(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "recovery-ref-created",
    });

    const boundaryStats = await inspect(action.target.path);
    if (!matchesFilesystemIdentity(boundaryStats, action)) {
      throw new WorktreeExecutionError(
        "worktree filesystem identity changed at the quarantine boundary",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    const boundaryMeasurement = await measure(action.target.path, {
      maxEntries: measurementMaxEntries,
      excludeRootEntries: [".git"],
    });
    if (
      boundaryMeasurement.truncated ||
      boundaryMeasurement.specialEntries > 0 ||
      boundaryMeasurement.mountBoundaries > 0 ||
      boundaryMeasurement.bytes !== action.target.measuredBytes ||
      boundaryMeasurement.newestMtimeMs !== action.target.newestMtimeMs ||
      boundaryMeasurement.fingerprint !== action.target.fingerprint
    ) {
      throw new WorktreeExecutionError(
        "worktree contents changed at the quarantine boundary",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    const boundaryMounts = await mountProbe(action.target.path);
    if (boundaryMounts.status !== "clear") {
      throw new WorktreeExecutionError(
        boundaryMounts.status === "blocked"
          ? "worktree gained a mount boundary before quarantine"
          : "mount boundaries could not be proven absent before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    const boundaryStatus = await runGit([
      "-C",
      action.target.path,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    const boundaryIndexFlags = await runGit(["-C", action.target.path, "ls-files", "-z", "-v"]);
    if (
      !cleanStatusMatches(boundaryStatus, action) ||
      countStatusSuppressedIndexEntries(boundaryIndexFlags) > 0
    ) {
      throw new WorktreeExecutionError(
        "worktree Git state changed before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    await assertNoGitOperations(action.target.path, entry, runGit, inspect);
    const boundaryOwnership = await processProbe(action.target.path);
    if (boundaryOwnership.status !== "idle") {
      throw new WorktreeExecutionError(
        boundaryOwnership.status === "busy"
          ? "a live process acquired the worktree before quarantine"
          : "live process ownership could not be proven idle before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (await pathExists(quarantinePath, inspect)) {
      throw new WorktreeExecutionError(
        `refusing to overwrite existing quarantine path ${quarantinePath}`,
        "failed",
        entry,
      );
    }

    assertAuthorized(dependencies.authorization, entry);
    try {
      await move(action.target.path, quarantinePath);
    } catch (error) {
      throw new WorktreeExecutionError(
        "worktree could not be atomically moved into quarantine",
        isMissing(error) ? "skipped-stale" : "failed",
        entry,
        {
          cause: error,
          ...(error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EXDEV"
            ? { diagnosticCode: "QUARANTINE_CROSS_DEVICE" }
            : isMissing(error)
              ? { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" }
              : {}),
        },
      );
    }
    moved = true;
    entry = await writeManifest(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "moved",
    });

    const [quarantinedStats, isolatedMeasurement] = await Promise.all([
      inspect(quarantinePath),
      measure(quarantinePath, {
        maxEntries: measurementMaxEntries,
        excludeRootEntries: [".git"],
      }),
    ]);
    if (
      !matchesFilesystemIdentity(quarantinedStats, action) ||
      isolatedMeasurement.truncated ||
      isolatedMeasurement.specialEntries > 0 ||
      isolatedMeasurement.mountBoundaries > 0 ||
      isolatedMeasurement.bytes !== action.target.measuredBytes ||
      isolatedMeasurement.newestMtimeMs !== action.target.newestMtimeMs ||
      isolatedMeasurement.fingerprint !== action.target.fingerprint
    ) {
      throw new WorktreeExecutionError(
        "worktree contents or identity changed during quarantine",
        "partially-applied",
        entry,
      );
    }
    await assertNoGitOperations(quarantinePath, entry, runGit, inspect);
    const beforeRepair = await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!targetRegistrationLockMatches(beforeRepair, action, action.target.path)) {
      throw new WorktreeExecutionError(
        "worktree registration or lock ownership changed before repair",
        "partially-applied",
        entry,
        { diagnosticCode: "QUARANTINE_REGISTRATION_CHANGED" },
      );
    }
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "repair",
      quarantinePath,
    ]);
    repaired = true;
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      worktreeLockReason(entryId),
      quarantinePath,
    ]);
    locked = true;
    const after = await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!registeredWorktree(after, quarantinePath, action, worktreeLockReason(entryId))) {
      throw new WorktreeExecutionError(
        "quarantined worktree registration could not be verified",
        "partially-applied",
        entry,
      );
    }
    const verifiedRef = (
      await runGit([
        "--git-dir",
        action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        recoveryRef,
      ])
    ).trim();
    if (verifiedRef !== action.target.head) {
      throw new WorktreeExecutionError(
        "quarantine recovery ref does not match the planned HEAD",
        "partially-applied",
        entry,
      );
    }
    const [quarantineStats, quarantineMeasurement] = await Promise.all([
      inspect(quarantinePath),
      measure(quarantinePath, {
        maxEntries: measurementMaxEntries,
        excludeRootEntries: [".git"],
      }),
    ]);
    if (
      !quarantineStats.isDirectory() ||
      quarantineStats.isSymbolicLink() ||
      quarantineStats.dev !== action.target.device ||
      quarantineStats.ino !== action.target.inode ||
      quarantineMeasurement.truncated ||
      quarantineMeasurement.specialEntries > 0 ||
      quarantineMeasurement.mountBoundaries > 0 ||
      quarantineMeasurement.bytes !== action.target.measuredBytes
    ) {
      throw new WorktreeExecutionError(
        "post-repair quarantine identity could not be proven",
        "partially-applied",
        entry,
      );
    }
    const finalStatus = await runGit([
      "-C",
      quarantinePath,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    const finalIndexFlags = await runGit(["-C", quarantinePath, "ls-files", "-z", "-v"]);
    if (
      !cleanStatusMatches(finalStatus, action) ||
      countStatusSuppressedIndexEntries(finalIndexFlags) > 0
    ) {
      throw new WorktreeExecutionError(
        "quarantined worktree Git state changed before commit",
        "partially-applied",
        entry,
      );
    }
    await assertNoGitOperations(quarantinePath, entry, runGit, inspect);
    const finalMounts = await mountProbe(quarantinePath);
    if (finalMounts.status !== "clear") {
      throw new WorktreeExecutionError(
        finalMounts.status === "blocked"
          ? "quarantined worktree gained a mount boundary before commit"
          : "mount boundaries could not be proven absent before quarantine commit",
        "partially-applied",
        entry,
      );
    }
    const finalOwnership = await processProbe(quarantinePath);
    if (finalOwnership.status !== "idle") {
      throw new WorktreeExecutionError(
        finalOwnership.status === "busy"
          ? "a live process acquired the quarantined worktree before commit"
          : "live process ownership could not be proven idle before quarantine commit",
        "partially-applied",
        entry,
      );
    }

    entry = await writeManifest(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "quarantined",
      quarantineIdentity: {
        ...action.target,
        path: quarantinePath,
        device: quarantineStats.dev,
        inode: quarantineStats.ino,
        mtimeMs: quarantineStats.mtimeMs,
        measuredBytes: quarantineMeasurement.bytes,
        newestMtimeMs: quarantineMeasurement.newestMtimeMs,
        fingerprint: quarantineMeasurement.fingerprint,
      },
    });
    return {
      quarantineEntryId: entry.entryId,
      quarantinePath: entry.quarantinePath,
      recoveryRef: entry.recoveryRef,
      quarantinedBytes: action.target.measuredBytes,
      manifestPath,
    };
  } catch (error) {
    const executionError =
      error instanceof WorktreeExecutionError
        ? error
        : new WorktreeExecutionError(
            error instanceof Error ? error.message : String(error),
            moved ? "partially-applied" : "failed",
            entry,
            { cause: error },
          );
    const diagnostic = {
      severity: "error" as const,
      code: executionError.diagnosticCode ?? "WORKTREE_QUARANTINE_FAILED",
      message: executionError.message,
      adapter: action.adapter,
      resourceId: action.resourceId,
    };

    let rollbackFinalizing = false;
    try {
      if (locked) {
        await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "unlock",
          quarantinePath,
        ]);
        locked = false;
      }
      if (moved) {
        await assertNoGitOperations(quarantinePath, entry, runGit, inspect);
        const beforeRollbackRepair = await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (
          !targetRegistrationLockMatches(
            beforeRollbackRepair,
            action,
            repaired ? quarantinePath : action.target.path,
          )
        ) {
          throw new Error("worktree lock ownership changed before automatic rollback");
        }
        if (
          (await pathExists(action.target.path, inspect)) ||
          !(await pathExists(quarantinePath, inspect))
        ) {
          throw new Error("worktree paths are not safe for automatic rollback");
        }
        await move(quarantinePath, action.target.path);
        moved = false;
        await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "repair",
          action.target.path,
        ]);
        const restored = await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (!registeredWorktree(restored, action.target.path, action)) {
          throw new Error("restored Git worktree registration could not be verified");
        }
      }
      rollbackFinalizing = true;
      if (refCreated) {
        await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "update-ref",
          "-d",
          recoveryRef,
          action.target.head,
        ]);
        refCreated = false;
      }
      entry = await writeManifest(manifestPath, options.quarantineDirectory, {
        ...entry,
        status: "restored",
        restoredAt: clock().toISOString(),
        diagnostic,
      });
      throw new WorktreeExecutionError(
        moved ? `${executionError.message}; worktree rollback completed` : executionError.message,
        executionError.outcome === "skipped-stale"
          ? "skipped-stale"
          : executionError.entry?.status === "moved" ||
              executionError.outcome === "partially-applied"
            ? "rolled-back"
            : "failed",
        entry,
        {
          cause: executionError,
          ...(executionError.diagnosticCode === undefined
            ? {}
            : { diagnosticCode: executionError.diagnosticCode }),
        },
      );
    } catch (rollbackError) {
      if (
        rollbackError instanceof WorktreeExecutionError &&
        rollbackError.cause === executionError
      ) {
        throw rollbackError;
      }
      if (rollbackFinalizing) {
        throw new WorktreeExecutionError(
          "worktree rollback restored the original path but finalization is pending; retry undo",
          "partially-applied",
          entry,
          {
            cause: rollbackError,
            diagnosticCode: "WORKTREE_ROLLBACK_FINALIZE_PENDING",
          },
        );
      }
      entry = await writeManifest(manifestPath, options.quarantineDirectory, {
        ...entry,
        status: "partial",
        diagnostic: {
          ...diagnostic,
          code: "WORKTREE_QUARANTINE_PARTIAL",
          message: `${executionError.message}; automatic rollback failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
        },
      }).catch(() => entry);
      throw new WorktreeExecutionError(
        `worktree quarantine failed with partial state; inspect ${manifestPath}`,
        "partially-applied",
        entry,
        {
          cause: rollbackError,
          diagnosticCode: "WORKTREE_QUARANTINE_PARTIAL",
          quarantinedBytes: moved ? action.target.measuredBytes : 0,
        },
      );
    }
  }
}
