import { lstat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  codexDatabaseContractMatches,
  inspectCodexDatabase,
  inspectCodexProcesses,
  inspectDatabaseOpenHandles,
  type CodexDatabaseDependencies,
} from "../adapters/codex-database.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { DatabaseVacuumAction } from "../contracts/action.js";
import type { Diagnostic } from "../contracts/diagnostic.js";

export type DatabaseRevalidationResult =
  | { status: "eligible" }
  | { status: "stale"; diagnostic: Diagnostic };

export type DatabaseRevalidationDependencies = CodexDatabaseDependencies & {
  inspectDatabase?: typeof inspectCodexDatabase;
  inspectProcesses?: typeof inspectCodexProcesses;
  inspectOpenHandles?: typeof inspectDatabaseOpenHandles;
  availableBytes?: (path: string) => Promise<number>;
};

function stale(action: DatabaseVacuumAction, code: string, message: string) {
  return {
    status: "stale" as const,
    diagnostic: {
      severity: "warning" as const,
      code,
      message,
      adapter: action.adapter,
      resourceId: action.resourceId,
    },
  };
}

async function defaultAvailableBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function configuredCodexDatabasePath(
  action: DatabaseVacuumAction,
  home: string,
  config: AgentRinseConfig,
): string {
  const root = resolve(config.adapters.codex?.root ?? join(home, ".codex"));
  return resolve(root, action.target.filename);
}

export async function revalidateDatabaseVacuum(
  action: DatabaseVacuumAction,
  home: string,
  config: AgentRinseConfig,
  dependencies: DatabaseRevalidationDependencies = {},
): Promise<DatabaseRevalidationResult> {
  const expectedPath = configuredCodexDatabasePath(action, home, config);
  if (resolve(action.target.path) !== expectedPath) {
    return stale(
      action,
      "DATABASE_PATH_CHANGED",
      "The planned database is no longer the configured Codex database path.",
    );
  }
  try {
    const rootStats = await lstat(dirname(expectedPath));
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return stale(
        action,
        "DATABASE_ROOT_UNSAFE",
        "The Codex database root is not a real directory.",
      );
    }
    const inspection = await (dependencies.inspectDatabase ?? inspectCodexDatabase)(
      expectedPath,
      dependencies,
    );
    if (
      inspection.identity.fingerprint !== action.target.fingerprint ||
      !codexDatabaseContractMatches(inspection.identity)
    ) {
      return stale(
        action,
        "DATABASE_IDENTITY_CHANGED",
        "The Codex database identity or supported schema changed after planning.",
      );
    }
    if ((inspection.identity.wal?.measuredBytes ?? 0) > 0) {
      return stale(
        action,
        "DATABASE_WAL_NOT_EMPTY",
        "The Codex database WAL contains uncheckpointed data.",
      );
    }
    const processes = await (dependencies.inspectProcesses ?? inspectCodexProcesses)(dependencies);
    if (processes.status !== "idle") {
      return stale(
        action,
        processes.status === "busy"
          ? "DATABASE_PROVIDER_ACTIVE"
          : "DATABASE_PROVIDER_STATE_UNKNOWN",
        processes.status === "busy"
          ? "Codex is running; offline database maintenance is refused."
          : processes.reason,
      );
    }
    const handles = await (dependencies.inspectOpenHandles ?? inspectDatabaseOpenHandles)(
      expectedPath,
      dependencies,
    );
    if (handles.status !== "idle") {
      return stale(
        action,
        handles.status === "busy"
          ? "DATABASE_DESCRIPTOR_ACTIVE"
          : "DATABASE_DESCRIPTOR_STATE_UNKNOWN",
        handles.status === "busy"
          ? "A process still has the database or a companion file open."
          : handles.reason,
      );
    }
    const availableBytes = await (dependencies.availableBytes ?? defaultAvailableBytes)(
      dirname(expectedPath),
    );
    const requiredBytes = action.target.measuredBytes * 2 + 64 * 1024 * 1024;
    if (availableBytes < requiredBytes) {
      return stale(
        action,
        "DATABASE_SPACE_INSUFFICIENT",
        "The database filesystem lacks peak space for compaction, normalization, and a safety margin.",
      );
    }
    return { status: "eligible" };
  } catch (error) {
    return stale(
      action,
      "DATABASE_REVALIDATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}
