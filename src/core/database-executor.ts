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
  retainedBackupBytes: number;
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
  const backupWalPath = action.target.wal === undefined ? undefined : `${backupPath}-wal`;
  const backupShmPath = action.target.shm === undefined ? undefined : `${backupPath}-shm`;
  const temporaryPath = join(
    originalDirectory,
    `.${action.target.filename}.${options.entryId}.vacuum`,
  );
  const manifestPath = join(options.backupDirectory, `${options.entryId}.json`);
  await ensurePrivateDirectory(options.backupDirectory);
  const backupDirectoryStats = await lstat(options.backupDirectory);
  const sourceStats = await lstat(action.target.path);
  if (backupDirectoryStats.dev !== sourceStats.dev) {
    throw new DatabaseExecutionError(
      "database rollback storage is on a different filesystem",
      "skipped-stale",
      "DATABASE_BACKUP_CROSS_DEVICE",
    );
  }
  if (
    (await pathExists(backupPath)) ||
    (backupWalPath !== undefined && (await pathExists(backupWalPath))) ||
    (backupShmPath !== undefined && (await pathExists(backupShmPath))) ||
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
      ...(backupWalPath === undefined ? {} : { backupWalPath }),
      ...(backupShmPath === undefined ? {} : { backupShmPath }),
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
    const compacted = await inspect(
      temporaryPath,
      dependencies,
      action.target.path,
      action.target.path,
    );
    if (
      compacted.identity.schemaDigest !== action.target.schemaDigest ||
      compacted.identity.migrationVersion !== action.target.migrationVersion ||
      compacted.identity.tables.join("\0") !== action.target.tables.join("\0") ||
      compacted.identity.autoVacuum !== 2 ||
      compacted.sidecarsPresent
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
    if (
      current.identity.fingerprint !== action.target.fingerprint ||
      (current.identity.wal?.measuredBytes ?? 0) > 0
    ) {
      throw new DatabaseExecutionError(
        "database identity changed before the atomic swap",
        "skipped-stale",
        "DATABASE_IDENTITY_CHANGED",
        entry,
      );
    }
    assertAuthorized(dependencies);

    const movedSidecars: Array<{ source: string; destination: string }> = [];
    try {
      if (action.target.wal !== undefined && backupWalPath !== undefined) {
        await rename(action.target.wal.path, backupWalPath);
        movedSidecars.push({ source: action.target.wal.path, destination: backupWalPath });
      }
      if (action.target.shm !== undefined && backupShmPath !== undefined) {
        await rename(action.target.shm.path, backupShmPath);
        movedSidecars.push({ source: action.target.shm.path, destination: backupShmPath });
      }
      await rename(action.target.path, backupPath);
    } catch (error) {
      for (const sidecar of movedSidecars.reverse()) {
        if (!(await pathExists(sidecar.source)) && (await pathExists(sidecar.destination))) {
          await rename(sidecar.destination, sidecar.source);
        }
      }
      await syncDirectory(originalDirectory);
      throw error;
    }
    await syncDirectory(originalDirectory);
    await syncDirectory(options.backupDirectory);
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

    entry = await persist(
      manifestPath,
      {
        ...entry,
        status: "installing",
        installedIdentity: compacted.identity,
      },
      options.backupDirectory,
    );
    try {
      await rename(temporaryPath, action.target.path);
      await syncDirectory(originalDirectory);
      await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
        action.target.path,
        dependencies,
      );
      const installed = await inspect(action.target.path, dependencies);
      if (installed.identity.fingerprint !== entry.installedIdentity?.fingerprint) {
        throw new Error("installed database identity changed during the atomic swap");
      }
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
        retainedBackupBytes:
          action.target.measuredBytes +
          (action.target.wal?.measuredBytes ?? 0) +
          (action.target.shm?.measuredBytes ?? 0),
        reclaimedBytes: 0,
      };
    } catch (installError) {
      try {
        const sourceExists = await pathExists(action.target.path);
        const backupExists = await pathExists(backupPath);
        const temporaryExists = await pathExists(temporaryPath);
        if (sourceExists && backupExists && !temporaryExists) {
          await rename(action.target.path, temporaryPath);
          await syncDirectory(originalDirectory);
        } else if (!(!sourceExists && backupExists && temporaryExists)) {
          throw new Error("database installation rollback paths are ambiguous");
        }
        await rename(backupPath, action.target.path);
        if (backupWalPath !== undefined && (await pathExists(backupWalPath))) {
          await rename(backupWalPath, `${action.target.path}-wal`);
        }
        if (backupShmPath !== undefined && (await pathExists(backupShmPath))) {
          await rename(backupShmPath, `${action.target.path}-shm`);
        }
        await syncDirectory(originalDirectory);
        await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
          action.target.path,
          dependencies,
        );
        const restored = await inspect(action.target.path, dependencies);
        if (restored.identity.fingerprint !== action.target.fingerprint) {
          throw new Error("restored database identity does not match the planned original");
        }
        await rm(temporaryPath, { force: true });
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
              message: installError instanceof Error ? installError.message : String(installError),
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          },
          options.backupDirectory,
        );
        throw new DatabaseExecutionError(
          "database installation failed and the original was restored",
          "rolled-back",
          "DATABASE_INSTALL_ROLLED_BACK",
          entry,
        );
      } catch (rollbackError) {
        if (rollbackError instanceof DatabaseExecutionError) {
          throw rollbackError;
        }
        entry = await persist(
          manifestPath,
          {
            ...entry,
            status: "partial",
            diagnostic: {
              severity: "error",
              code: "DATABASE_INSTALL_ROLLBACK_PARTIAL",
              message: `install failed: ${
                installError instanceof Error ? installError.message : String(installError)
              }; rollback failed: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`,
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          },
          options.backupDirectory,
        );
        throw new DatabaseExecutionError(
          "database installation and automatic rollback did not complete",
          "partially-applied",
          "DATABASE_INSTALL_ROLLBACK_PARTIAL",
          entry,
        );
      }
    }
  } catch (error) {
    if (error instanceof DatabaseExecutionError) {
      const sourceExists = await pathExists(action.target.path).catch(() => false);
      const backupExists = await pathExists(backupPath).catch(() => false);
      if (error.outcome === "skipped-stale" && sourceExists && !backupExists) {
        await rm(temporaryPath, { force: true });
        await syncDirectory(originalDirectory);
        entry = await persist(
          manifestPath,
          {
            ...entry,
            status: "restored",
            restoredAt: clock().toISOString(),
            diagnostic: {
              severity: "warning",
              code: error.diagnosticCode,
              message: error.message,
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          },
          options.backupDirectory,
        );
        throw new DatabaseExecutionError(error.message, error.outcome, error.diagnosticCode, entry);
      }
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
