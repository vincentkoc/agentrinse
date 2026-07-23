import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactRemoveAction } from "../contracts/action.js";

export type ArtifactExecutionOutcome = "failed" | "rolled-back" | "partially-applied";

export class ArtifactExecutionError extends Error {
  override readonly name = "ArtifactExecutionError";

  constructor(
    message: string,
    readonly outcome: ArtifactExecutionOutcome,
    readonly isolationPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ArtifactExecutionResult = {
  reclaimedBytes: number;
  isolationPath: string;
};

export type ArtifactExecutorDependencies = {
  id?: () => string;
  inspect?: (path: string) => Promise<Stats>;
  move?: (source: string, destination: string) => Promise<void>;
  remove?: (path: string) => Promise<void>;
};

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
  const remove =
    dependencies.remove ??
    (async (path: string) =>
      rm(path, {
        recursive: true,
        force: false,
        maxRetries: 3,
        retryDelay: 100,
      }));
  const isolationPath = join(
    dirname(action.target.path),
    `.agentrinse-${dependencies.id?.() ?? randomUUID()}.tombstone`,
  );

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
      "failed",
      isolationPath,
      { cause: error },
    );
  }
  if (!matchesIdentity(before, action)) {
    throw new ArtifactExecutionError(
      "artifact identity changed before isolation",
      "failed",
      isolationPath,
    );
  }

  try {
    await move(action.target.path, isolationPath);
  } catch (error) {
    throw new ArtifactExecutionError(
      "artifact could not be atomically isolated",
      "failed",
      isolationPath,
      { cause: error },
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
    try {
      await move(isolationPath, action.target.path);
      throw new ArtifactExecutionError(
        "artifact identity changed during isolation; original path restored",
        "rolled-back",
        action.target.path,
      );
    } catch (error) {
      if (error instanceof ArtifactExecutionError && error.outcome === "rolled-back") {
        throw error;
      }
      throw new ArtifactExecutionError(
        `artifact identity changed and rollback failed; recovery path: ${isolationPath}`,
        "partially-applied",
        isolationPath,
        { cause: error },
      );
    }
  }

  try {
    await remove(isolationPath);
  } catch (error) {
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

  return {
    reclaimedBytes: action.target.measuredBytes,
    isolationPath,
  };
}
