import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import type { WorktreeQuarantineAction } from "../contracts/action.js";
import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { ensurePrivateDirectory, writeJsonAtomic } from "../state/json-file.js";
import { sha256 } from "./digest.js";
import { measurePath, type Measurement } from "./measure.js";

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
    options?: ErrorOptions & { diagnosticCode?: string },
  ) {
    super(message, options);
    this.diagnosticCode = options?.diagnosticCode;
  }

  readonly diagnosticCode: string | undefined;
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
  measure?: (path: string, options: { maxEntries: number }) => Promise<Measurement>;
  maxEntries?: number;
  clock?: () => Date;
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
  return `refs/agentrinse/quarantine/${runId}/${sha256(action.resourceId).slice(0, 16)}`;
}

function registeredWorktree(
  output: string,
  path: string,
  action: WorktreeQuarantineAction,
  requireLocked: boolean,
): boolean {
  const expectedPath = resolve(path);
  return parseWorktreePorcelain(output).some(
    (record) =>
      resolve(record.path) === expectedPath &&
      record.head === action.target.head &&
      record.branch === action.target.branch &&
      (!requireLocked || record.locked !== undefined),
  );
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
  const move = dependencies.move ?? rename;
  const measure = dependencies.measure ?? measurePath;
  const clock = dependencies.clock ?? (() => new Date());
  const quarantinePath = worktreeQuarantinePath(action, options.entryId);
  const quarantineParent = dirname(quarantinePath);
  const recoveryRef = worktreeRecoveryRef(action, options.runId);
  const manifestPath = join(options.quarantineDirectory, `${options.entryId}.json`);
  const createdAt = clock();
  let entry = quarantineEntrySchema.parse({
    schemaVersion: 1,
    entryId: options.entryId,
    runId: options.runId,
    actionId: action.actionId,
    resourceId: action.resourceId,
    status: "preparing",
    originalPath: action.target.path,
    quarantinePath,
    recoveryRef,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + action.quarantineTtlMinutes * 60_000).toISOString(),
    target: action.target,
  });
  let refCreated = false;
  let moved = false;
  let locked = false;

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
    if (!registeredWorktree(before, action.target.path, action, false)) {
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
        maxEntries: dependencies.maxEntries ?? 100_000,
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
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "repair",
      quarantinePath,
    ]);
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      `AgentRinse quarantine ${options.entryId}`,
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
    if (!registeredWorktree(after, quarantinePath, action, true)) {
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
        maxEntries: dependencies.maxEntries ?? 100_000,
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
        if (!registeredWorktree(restored, action.target.path, action, false)) {
          throw new Error("restored Git worktree registration could not be verified");
        }
      }
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
        { cause: rollbackError, diagnosticCode: "WORKTREE_QUARANTINE_PARTIAL" },
      );
    }
  }
}
