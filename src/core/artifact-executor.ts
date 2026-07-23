import { randomUUID } from "node:crypto";
import { lstatSync, rmSync, type Stats } from "node:fs";
import { lstat, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactRemoveAction } from "../contracts/action.js";
import { measurePath, type Measurement } from "./measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "./mount-boundaries.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";

export type ArtifactExecutionOutcome =
  | "skipped-stale"
  | "failed"
  | "rolled-back"
  | "partially-applied";

export class ArtifactExecutionError extends Error {
  override readonly name = "ArtifactExecutionError";

  constructor(
    message: string,
    readonly outcome: ArtifactExecutionOutcome,
    readonly isolationPath?: string,
    options?: ErrorOptions & { diagnosticCode?: string },
  ) {
    super(message, options);
    this.diagnosticCode = options?.diagnosticCode;
  }

  readonly diagnosticCode: string | undefined;
}

export type ArtifactExecutionResult = {
  reclaimedBytes: number;
  isolationPath: string;
};

export type ArtifactExecutorDependencies = {
  id?: () => string;
  inspect?: (path: string) => Promise<Stats>;
  finalInspect?: (path: string) => Stats;
  move?: (source: string, destination: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  measure?: (path: string, options: { maxEntries: number }) => Promise<Measurement>;
  processProbe?: (path: string) => Promise<ProcessOwnershipResult>;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
  maxEntries?: number;
  authorization?: {
    expiresAtMs: number;
    now: () => Date;
  };
};

export function artifactIsolationPath(action: ArtifactRemoveAction, id: string): string {
  return join(dirname(action.target.path), `.agentrinse-${id}.tombstone`);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function matchesIdentity(stats: Stats, action: ArtifactRemoveAction): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.dev === action.target.device &&
    stats.ino === action.target.inode &&
    stats.mtimeMs === action.target.mtimeMs
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

export async function executeArtifactRemove(
  action: ArtifactRemoveAction,
  dependencies: ArtifactExecutorDependencies = {},
): Promise<ArtifactExecutionResult> {
  const inspect = dependencies.inspect ?? lstat;
  const move = dependencies.move ?? rename;
  const measure = dependencies.measure ?? measurePath;
  const processProbe = dependencies.processProbe ?? findProcessesUsingPath;
  const mountProbe = dependencies.mountProbe ?? findMountBoundaries;
  const isolationPath = artifactIsolationPath(action, dependencies.id?.() ?? randomUUID());

  if (await pathExists(isolationPath, inspect)) {
    throw new ArtifactExecutionError(
      `refusing to overwrite existing isolation path ${isolationPath}`,
      "failed",
      isolationPath,
    );
  }

  let before: Stats;
  try {
    before = await inspect(action.target.path);
  } catch (error) {
    throw new ArtifactExecutionError(
      "artifact disappeared before isolation",
      isMissing(error) ? "skipped-stale" : "failed",
      isolationPath,
      {
        cause: error,
        ...(isMissing(error) ? { diagnosticCode: "ARTIFACT_IDENTITY_CHANGED" } : {}),
      },
    );
  }
  if (!matchesIdentity(before, action)) {
    throw new ArtifactExecutionError(
      "artifact identity changed before isolation",
      "skipped-stale",
      isolationPath,
      { diagnosticCode: "ARTIFACT_IDENTITY_CHANGED" },
    );
  }

  if (
    dependencies.authorization !== undefined &&
    dependencies.authorization.now().getTime() >= dependencies.authorization.expiresAtMs
  ) {
    throw new ArtifactExecutionError(
      "cleanup plan authorization expired before artifact isolation",
      "skipped-stale",
      isolationPath,
      { diagnosticCode: "PLAN_EXPIRED_DURING_APPLY" },
    );
  }

  try {
    await move(action.target.path, isolationPath);
  } catch (error) {
    throw new ArtifactExecutionError(
      "artifact could not be atomically isolated",
      isMissing(error) ? "skipped-stale" : "failed",
      isolationPath,
      {
        cause: error,
        ...(isMissing(error) ? { diagnosticCode: "ARTIFACT_IDENTITY_CHANGED" } : {}),
      },
    );
  }

  let isolated: Stats;
  try {
    isolated = await inspect(isolationPath);
  } catch (error) {
    throw new ArtifactExecutionError(
      `isolated artifact cannot be inspected; recovery path: ${isolationPath}`,
      "partially-applied",
      isolationPath,
      { cause: error },
    );
  }

  if (!matchesIdentity(isolated, action)) {
    await rollbackBeforeRemoval(
      "artifact identity changed during isolation",
      action,
      isolationPath,
      inspect,
      move,
    );
  }

  try {
    const measurement = await measure(isolationPath, {
      maxEntries: dependencies.maxEntries ?? 100_000,
    });
    if (
      measurement.truncated ||
      measurement.specialEntries > 0 ||
      measurement.mountBoundaries > 0 ||
      measurement.bytes !== action.target.measuredBytes ||
      measurement.newestMtimeMs !== action.target.newestMtimeMs ||
      measurement.fingerprint !== action.target.fingerprint
    ) {
      await rollbackBeforeRemoval(
        "artifact contents changed during isolation",
        action,
        isolationPath,
        inspect,
        move,
      );
    }

    const ownership = await processProbe(isolationPath);
    if (ownership.status !== "idle") {
      await rollbackBeforeRemoval(
        ownership.status === "busy"
          ? "a process acquired the artifact during isolation"
          : "process ownership became unknown during isolation",
        action,
        isolationPath,
        inspect,
        move,
      );
    }

    const mounts = await mountProbe(isolationPath);
    if (mounts.status !== "clear") {
      await rollbackBeforeRemoval(
        mounts.status === "blocked"
          ? "artifact contains a mount boundary during isolation"
          : "mount boundaries became unknown during isolation",
        action,
        isolationPath,
        inspect,
        move,
      );
    }
  } catch (error) {
    if (error instanceof ArtifactExecutionError) {
      throw error;
    }
    await rollbackBeforeRemoval(
      "artifact could not be revalidated after isolation",
      action,
      isolationPath,
      inspect,
      move,
      error,
    );
  }

  const finalMounts = await mountProbe(isolationPath).catch((error: unknown) =>
    rollbackBeforeRemoval(
      "mount boundaries could not be rechecked before removal",
      action,
      isolationPath,
      inspect,
      move,
      error,
    ),
  );
  if (finalMounts.status !== "clear") {
    await rollbackBeforeRemoval(
      finalMounts.status === "blocked"
        ? "artifact gained a mount boundary before removal"
        : "mount boundaries became unknown before removal",
      action,
      isolationPath,
      inspect,
      move,
    );
  }

  if (
    dependencies.authorization !== undefined &&
    dependencies.authorization.now().getTime() >= dependencies.authorization.expiresAtMs
  ) {
    await rollbackBeforeRemoval(
      "cleanup plan authorization expired during artifact isolation",
      action,
      isolationPath,
      inspect,
      move,
    );
  }

  try {
    const finalStats = (dependencies.finalInspect ?? lstatSync)(isolationPath);
    if (!matchesIdentity(finalStats, action)) {
      throw new ArtifactExecutionError(
        `isolated artifact identity changed before removal; inspect ${isolationPath}`,
        "partially-applied",
        isolationPath,
      );
    }

    if (dependencies.remove === undefined) {
      rmSync(isolationPath, {
        recursive: true,
        force: false,
        maxRetries: 3,
        retryDelay: 100,
      });
    } else {
      await dependencies.remove(isolationPath);
    }
  } catch (error) {
    if (error instanceof ArtifactExecutionError) {
      throw error;
    }
    let recoveryPath = isolationPath;
    try {
      if (
        !(await pathExists(action.target.path, inspect)) &&
        (await pathExists(isolationPath, inspect))
      ) {
        await move(isolationPath, action.target.path);
        recoveryPath = action.target.path;
      }
    } catch {
      // The durable journal records the last known isolation path below.
    }
    throw new ArtifactExecutionError(
      `artifact removal failed after isolation; inspect recovery path ${recoveryPath}`,
      "partially-applied",
      recoveryPath,
      { cause: error },
    );
  }

  try {
    if (
      (await pathExists(action.target.path, inspect)) ||
      (await pathExists(isolationPath, inspect))
    ) {
      throw new ArtifactExecutionError(
        `artifact removal postcondition failed; inspect ${isolationPath}`,
        "partially-applied",
        isolationPath,
      );
    }
  } catch (error) {
    if (error instanceof ArtifactExecutionError) {
      throw error;
    }
    throw new ArtifactExecutionError(
      `artifact removal completed but postconditions could not be verified; inspect ${isolationPath}`,
      "partially-applied",
      isolationPath,
      { cause: error },
    );
  }

  return {
    reclaimedBytes: action.target.measuredBytes,
    isolationPath,
  };
}

async function rollbackBeforeRemoval(
  reason: string,
  action: ArtifactRemoveAction,
  isolationPath: string,
  inspect: (path: string) => Promise<Stats>,
  move: (source: string, destination: string) => Promise<void>,
  cause?: unknown,
): Promise<never> {
  try {
    if (await pathExists(action.target.path, inspect)) {
      throw new Error("original path reappeared before rollback");
    }
    await move(isolationPath, action.target.path);
  } catch (error) {
    throw new ArtifactExecutionError(
      `${reason} and rollback failed; recovery path: ${isolationPath}`,
      "partially-applied",
      isolationPath,
      { cause: error },
    );
  }

  throw new ArtifactExecutionError(
    `${reason}; original path restored`,
    "rolled-back",
    action.target.path,
    cause === undefined ? undefined : { cause },
  );
}
