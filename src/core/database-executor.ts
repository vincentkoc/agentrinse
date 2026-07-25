import { chmod, lstat, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  inspectCodexDatabase,
  inspectCodexProcesses,
  inspectDatabaseOpenHandles,
  vacuumCodexDatabaseInto,
  verifyCodexDatabaseIntegrity,
  type CodexDatabaseDependencies,
} from "../adapters/codex-database.js";
import type { DatabaseVacuumAction } from "../contracts/action.js";
import {
  databaseBackupEntrySchema,
  type DatabaseBackupEntry,
} from "../contracts/database-backup.js";
import { ensurePrivateDirectory, syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import { renameNoReplace } from "./no-clobber-rename.js";

export type DatabaseExecutionOutcome =
  | "failed"
  | "rolled-back"
  | "partially-applied"
  | "skipped-stale";

export class DatabaseExecutionError extends Error {
  override readonly name = "DatabaseExecutionError";

  constructor(
    message: string,
    readonly outcome: DatabaseExecutionOutcome,
    readonly diagnosticCode: string,
    readonly entry?: DatabaseBackupEntry,
  ) {
    super(message);
  }
}

export type DatabaseExecutionDependencies = CodexDatabaseDependencies & {
  clock?: () => Date;
  inspectDatabase?: typeof inspectCodexDatabase;
  inspectProcesses?: typeof inspectCodexProcesses;
  inspectOpenHandles?: typeof inspectDatabaseOpenHandles;
  vacuumInto?: typeof vacuumCodexDatabaseInto;
  verifyIntegrity?: typeof verifyCodexDatabaseIntegrity;
  rename?: typeof renameNoReplace;
  authorization?: {
    expiresAtMs: number;
    now: () => Date;
  };
};

export type ExecuteDatabaseVacuumOptions = {
  runId: string;
  entryId: string;
  backupDirectory: string;
  dependencies?: DatabaseExecutionDependencies;
};

export type DatabaseExecutionResult = {
  backupEntryId: string;
  backupPath: string;
  originalBytes: number;
  compactedBytes: number;
  reclaimedBytes: number;
};

function assertAuthorized(dependencies: DatabaseExecutionDependencies): void {
  if (
    dependencies.authorization !== undefined &&
    dependencies.authorization.now().getTime() >= dependencies.authorization.expiresAtMs
  ) {
    throw new DatabaseExecutionError(
      "cleanup plan authorization expired before the database swap",
      "skipped-stale",
      "PLAN_EXPIRED_DURING_DATABASE_VACUUM",
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertOffline(
  path: string,
  dependencies: DatabaseExecutionDependencies,
): Promise<void> {
  const processes = await (dependencies.inspectProcesses ?? inspectCodexProcesses)(dependencies);
  if (processes.status !== "idle") {
    throw new DatabaseExecutionError(
      processes.status === "busy"
        ? "Codex started before the database swap"
        : `Codex process state is unknown: ${processes.reason}`,
      "skipped-stale",
      processes.status === "busy" ? "DATABASE_PROVIDER_ACTIVE" : "DATABASE_PROVIDER_STATE_UNKNOWN",
    );
  }
  const handles = await (dependencies.inspectOpenHandles ?? inspectDatabaseOpenHandles)(
    path,
    dependencies,
  );
  if (handles.status !== "idle") {
    throw new DatabaseExecutionError(
      handles.status === "busy"
        ? "a process opened the database before the swap"
        : `database descriptor state is unknown: ${handles.reason}`,
      "skipped-stale",
      handles.status === "busy"
        ? "DATABASE_DESCRIPTOR_ACTIVE"
        : "DATABASE_DESCRIPTOR_STATE_UNKNOWN",
    );
  }
}

async function persist(
  manifestPath: string,
  entry: DatabaseBackupEntry,
  backupDirectory: string,
): Promise<DatabaseBackupEntry> {
  const parsed = databaseBackupEntrySchema.parse(entry);
  await writeJsonAtomic(manifestPath, parsed, {
    privateDirectories: [backupDirectory],
  });
  return parsed;
}

export async function executeDatabaseVacuum(
  action: DatabaseVacuumAction,
  options: ExecuteDatabaseVacuumOptions,
): Promise<DatabaseExecutionResult> {
  const dependencies = options.dependencies ?? {};
  const clock = dependencies.clock ?? (() => new Date());
  const rename = dependencies.rename ?? renameNoReplace;
  const inspect = dependencies.inspectDatabase ?? inspectCodexDatabase;
  const originalDirectory = dirname(action.target.path);
  const backupPath = join(
    options.backupDirectory,
    `${options.entryId}-${action.target.filename}.original`,
  );
  const temporaryPath = join(
    originalDirectory,
    `.${action.target.filename}.${options.entryId}.vacuum`,
  );
  const manifestPath = join(options.backupDirectory, `${options.entryId}.json`);
  await ensurePrivateDirectory(options.backupDirectory);
  if (
    (await pathExists(backupPath)) ||
    (await pathExists(temporaryPath)) ||
    (await pathExists(manifestPath))
  ) {
    throw new DatabaseExecutionError(
      "database maintenance destination already exists",
      "failed",
      "DATABASE_DESTINATION_OCCUPIED",
    );
  }

  let entry = await persist(
    manifestPath,
    {
      schemaVersion: 1,
      entryId: options.entryId,
      runId: options.runId,
      actionId: action.actionId,
      resourceId: action.resourceId,
      status: "preparing",
      originalPath: action.target.path,
      backupPath,
      temporaryPath,
      createdAt: clock().toISOString(),
      expiresAt: new Date(clock().getTime() + action.backupTtlMinutes * 60_000).toISOString(),
      target: action.target,
    },
    options.backupDirectory,
  );

  try {
    await assertOffline(action.target.path, dependencies);
    assertAuthorized(dependencies);
    await (dependencies.vacuumInto ?? vacuumCodexDatabaseInto)(
      action.target.path,
      temporaryPath,
      dependencies,
    );
    await chmod(temporaryPath, action.target.mode & 0o777);
    await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
      temporaryPath,
      dependencies,
    );
    const compacted = await inspect(temporaryPath, dependencies, action.target.path);
    if (
      compacted.identity.schemaDigest !== action.target.schemaDigest ||
      compacted.identity.migrationVersion !== action.target.migrationVersion ||
      compacted.identity.tables.join("\0") !== action.target.tables.join("\0") ||
      compacted.identity.autoVacuum !== 2
    ) {
      throw new DatabaseExecutionError(
        "compacted database does not match the planned Codex contract",
        "failed",
        "DATABASE_COMPACTED_CONTRACT_CHANGED",
        entry,
      );
    }
    await syncFile(temporaryPath);
    entry = await persist(manifestPath, { ...entry, status: "vacuumed" }, options.backupDirectory);

    await assertOffline(action.target.path, dependencies);
    assertAuthorized(dependencies);
    const current = await inspect(action.target.path, dependencies);
    if (current.identity.fingerprint !== action.target.fingerprint || current.sidecarsPresent) {
      throw new DatabaseExecutionError(
        "database identity changed before the atomic swap",
        "skipped-stale",
        "DATABASE_IDENTITY_CHANGED",
        entry,
      );
    }

    await rename(action.target.path, backupPath);
    await syncDirectory(originalDirectory);
    const backup = await inspect(backupPath, dependencies, action.target.path);
    entry = await persist(
      manifestPath,
      {
        ...entry,
        status: "original-backed-up",
        backupIdentity: backup.identity,
      },
      options.backupDirectory,
    );

    try {
      await rename(temporaryPath, action.target.path);
      await syncDirectory(originalDirectory);
    } catch (error) {
      if (!(await pathExists(action.target.path)) && (await pathExists(backupPath))) {
        await rename(backupPath, action.target.path);
        await syncDirectory(originalDirectory);
        entry = await persist(
          manifestPath,
          {
            ...entry,
            status: "restored",
            restoredAt: clock().toISOString(),
            diagnostic: {
              severity: "error",
              code: "DATABASE_INSTALL_ROLLED_BACK",
              message: error instanceof Error ? error.message : String(error),
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          },
          options.backupDirectory,
        );
        await rm(temporaryPath, { force: true });
        throw new DatabaseExecutionError(
          "database installation failed and the original was restored",
          "rolled-back",
          "DATABASE_INSTALL_ROLLED_BACK",
          entry,
        );
      }
      throw error;
    }

    await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
      action.target.path,
      dependencies,
    );
    const installed = await inspect(action.target.path, dependencies);
    entry = await persist(
      manifestPath,
      {
        ...entry,
        status: "installed",
        installedIdentity: installed.identity,
      },
      options.backupDirectory,
    );
    return {
      backupEntryId: entry.entryId,
      backupPath: entry.backupPath,
      originalBytes: action.target.measuredBytes,
      compactedBytes: installed.identity.measuredBytes,
      reclaimedBytes: Math.max(0, action.target.measuredBytes - installed.identity.measuredBytes),
    };
  } catch (error) {
    if (error instanceof DatabaseExecutionError) {
      throw error;
    }
    const sourceExists = await pathExists(action.target.path).catch(() => false);
    const backupExists = await pathExists(backupPath).catch(() => false);
    const outcome = !sourceExists && backupExists ? "partially-applied" : "failed";
    entry = await persist(
      manifestPath,
      {
        ...entry,
        status: outcome === "partially-applied" ? "partial" : entry.status,
        diagnostic: {
          severity: "error",
          code:
            outcome === "partially-applied" ? "DATABASE_VACUUM_PARTIAL" : "DATABASE_VACUUM_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: action.adapter,
          resourceId: action.resourceId,
        },
      },
      options.backupDirectory,
    );
    throw new DatabaseExecutionError(
      error instanceof Error ? error.message : String(error),
      outcome,
      outcome === "partially-applied" ? "DATABASE_VACUUM_PARTIAL" : "DATABASE_VACUUM_FAILED",
      entry,
    );
  }
}
