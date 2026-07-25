import { lstat, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  inspectCodexDatabase,
  inspectCodexProcesses,
  inspectDatabaseOpenHandles,
  verifyCodexDatabaseIntegrity,
  type CodexDatabaseDependencies,
} from "../adapters/codex-database.js";
import {
  databaseBackupEntrySchema,
  type DatabaseBackupEntry,
} from "../contracts/database-backup.js";
import { syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import { renameNoReplace } from "./no-clobber-rename.js";

export type DatabaseRecoveryDependencies = CodexDatabaseDependencies & {
  clock?: () => Date;
  inspectDatabase?: typeof inspectCodexDatabase;
  inspectProcesses?: typeof inspectCodexProcesses;
  inspectOpenHandles?: typeof inspectDatabaseOpenHandles;
  verifyIntegrity?: typeof verifyCodexDatabaseIntegrity;
  rename?: typeof renameNoReplace;
};

export type DatabaseRecoveryOptions = {
  manifestPath: string;
  backupDirectory: string;
  dependencies?: DatabaseRecoveryDependencies;
};

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

async function persist(
  options: DatabaseRecoveryOptions,
  entry: DatabaseBackupEntry,
): Promise<DatabaseBackupEntry> {
  const parsed = databaseBackupEntrySchema.parse(entry);
  await writeJsonAtomic(options.manifestPath, parsed, {
    privateDirectories: [options.backupDirectory],
  });
  return parsed;
}

function assertRecoveryPaths(entry: DatabaseBackupEntry, options: DatabaseRecoveryOptions): void {
  const backupDirectory = resolve(options.backupDirectory);
  const expectedBackupPath = join(
    backupDirectory,
    `${entry.entryId}-${entry.target.filename}.original`,
  );
  const expectedTemporaryPath = join(
    dirname(entry.originalPath),
    `.${entry.target.filename}.${entry.entryId}.vacuum`,
  );
  const expectedManifestPath = join(backupDirectory, `${entry.entryId}.json`);
  if (
    resolve(entry.originalPath) !== resolve(entry.target.path) ||
    resolve(entry.backupPath) !== expectedBackupPath ||
    resolve(entry.temporaryPath) !== resolve(expectedTemporaryPath) ||
    resolve(options.manifestPath) !== expectedManifestPath ||
    (entry.backupWalPath !== undefined &&
      resolve(entry.backupWalPath) !== `${expectedBackupPath}-wal`) ||
    (entry.backupShmPath !== undefined &&
      resolve(entry.backupShmPath) !== `${expectedBackupPath}-shm`)
  ) {
    throw new Error("database recovery manifest contains paths outside its owned backup set");
  }
}

async function assertOffline(
  entry: DatabaseBackupEntry,
  dependencies: DatabaseRecoveryDependencies,
): Promise<void> {
  const processes = await (dependencies.inspectProcesses ?? inspectCodexProcesses)(dependencies);
  if (processes.status !== "idle") {
    throw new Error(
      processes.status === "busy"
        ? "Codex is running; database recovery is refused"
        : `Codex process state is unknown: ${processes.reason}`,
    );
  }
  for (const path of [entry.originalPath, entry.backupPath, entry.temporaryPath]) {
    const handles = await (dependencies.inspectOpenHandles ?? inspectDatabaseOpenHandles)(
      path,
      dependencies,
    );
    if (handles.status !== "idle") {
      throw new Error(
        handles.status === "busy"
          ? `a process has a database recovery path open: ${path}`
          : `database descriptor state is unknown: ${handles.reason}`,
      );
    }
  }
}

async function markRestored(
  options: DatabaseRecoveryOptions,
  entry: DatabaseBackupEntry,
  clock: () => Date,
): Promise<DatabaseBackupEntry> {
  return persist(options, {
    ...entry,
    status: "restored",
    restoredAt: clock().toISOString(),
    diagnostic: undefined,
  });
}

function backupSidecars(entry: DatabaseBackupEntry): Array<{ backup: string; original: string }> {
  return [
    ...(entry.backupWalPath === undefined
      ? []
      : [{ backup: entry.backupWalPath, original: `${entry.originalPath}-wal` }]),
    ...(entry.backupShmPath === undefined
      ? []
      : [{ backup: entry.backupShmPath, original: `${entry.originalPath}-shm` }]),
  ];
}

async function restoreSidecars(
  entry: DatabaseBackupEntry,
  rename: typeof renameNoReplace,
): Promise<void> {
  for (const sidecar of backupSidecars(entry)) {
    if (await pathExists(sidecar.backup)) {
      if (await pathExists(sidecar.original)) {
        throw new Error(`database sidecar restore destination is occupied: ${sidecar.original}`);
      }
      await rename(sidecar.backup, sidecar.original);
    }
  }
}

export async function undoDatabaseVacuum(
  input: DatabaseBackupEntry,
  options: DatabaseRecoveryOptions,
): Promise<DatabaseBackupEntry> {
  let entry = databaseBackupEntrySchema.parse(input);
  assertRecoveryPaths(entry, options);
  const dependencies = options.dependencies ?? {};
  const clock = dependencies.clock ?? (() => new Date());
  const rename = dependencies.rename ?? renameNoReplace;
  const inspect = dependencies.inspectDatabase ?? inspectCodexDatabase;
  await assertOffline(entry, dependencies);

  const originalExists = await pathExists(entry.originalPath);
  const backupExists = await pathExists(entry.backupPath);
  const temporaryExists = await pathExists(entry.temporaryPath);

  if (["preparing", "vacuumed"].includes(entry.status)) {
    if (!originalExists || backupExists) {
      throw new Error("interrupted database preparation has ambiguous file state");
    }
    await restoreSidecars(entry, rename);
    if (temporaryExists) {
      await rm(entry.temporaryPath);
      await syncDirectory(dirname(entry.originalPath));
    }
    return markRestored(options, entry, clock);
  }

  if (entry.status === "original-backed-up" || entry.status === "partial") {
    if (!originalExists && backupExists) {
      await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
        entry.backupPath,
        dependencies,
      );
      entry = await persist(options, { ...entry, status: "restoring" });
      await rename(entry.backupPath, entry.originalPath);
      await restoreSidecars(entry, rename);
      await syncDirectory(dirname(entry.originalPath));
      if (temporaryExists) {
        await rm(entry.temporaryPath);
      }
      return markRestored(options, entry, clock);
    }
    if (!(originalExists && backupExists && !temporaryExists)) {
      throw new Error("partial database vacuum has ambiguous file state");
    }
  }

  if (!["installed", "restoring", "original-backed-up", "partial"].includes(entry.status)) {
    throw new Error(`database backup entry cannot be restored from ${entry.status}`);
  }

  const currentOriginalExists = await pathExists(entry.originalPath);
  const currentBackupExists = await pathExists(entry.backupPath);
  const currentTemporaryExists = await pathExists(entry.temporaryPath);

  if (entry.status === "restoring") {
    if (!currentOriginalExists && currentBackupExists && currentTemporaryExists) {
      await rename(entry.backupPath, entry.originalPath);
      await restoreSidecars(entry, rename);
      await syncDirectory(dirname(entry.originalPath));
      await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
        entry.originalPath,
        dependencies,
      );
      await rm(entry.temporaryPath);
      return markRestored(options, entry, clock);
    }
    if (currentOriginalExists && !currentBackupExists && currentTemporaryExists) {
      await restoreSidecars(entry, rename);
      await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
        entry.originalPath,
        dependencies,
      );
      await rm(entry.temporaryPath);
      return markRestored(options, entry, clock);
    }
    if (!(currentOriginalExists && currentBackupExists && !currentTemporaryExists)) {
      throw new Error("interrupted database restore has ambiguous file state");
    }
  }

  if (!currentOriginalExists || !currentBackupExists || currentTemporaryExists) {
    throw new Error("database restore paths do not match a recoverable state");
  }
  const installed = await inspect(entry.originalPath, dependencies);
  if (
    entry.installedIdentity === undefined ||
    installed.identity.fingerprint !== entry.installedIdentity.fingerprint ||
    installed.sidecarsPresent
  ) {
    throw new Error(
      "the compacted database changed after installation; automatic undo is no longer safe",
    );
  }
  const backup = await inspect(entry.backupPath, dependencies, entry.originalPath);
  if (
    entry.backupIdentity === undefined ||
    backup.identity.fingerprint !== entry.backupIdentity.fingerprint ||
    (backup.identity.wal?.measuredBytes ?? 0) > 0
  ) {
    throw new Error("the retained original database no longer matches its recovery manifest");
  }
  await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
    entry.backupPath,
    dependencies,
  );
  entry = await persist(options, { ...entry, status: "restoring" });
  await rename(entry.originalPath, entry.temporaryPath);
  await syncDirectory(dirname(entry.originalPath));
  try {
    await rename(entry.backupPath, entry.originalPath);
    await restoreSidecars(entry, rename);
    await syncDirectory(dirname(entry.originalPath));
    await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
      entry.originalPath,
      dependencies,
    );
    await rm(entry.temporaryPath);
    return markRestored(options, entry, clock);
  } catch (error) {
    if (!(await pathExists(entry.originalPath)) && (await pathExists(entry.temporaryPath))) {
      await rename(entry.temporaryPath, entry.originalPath);
      await syncDirectory(dirname(entry.originalPath));
      entry = await persist(options, {
        ...entry,
        status: "installed",
        diagnostic: {
          severity: "error",
          code: "DATABASE_UNDO_ROLLED_BACK",
          message: error instanceof Error ? error.message : String(error),
          adapter: "codex",
          resourceId: entry.resourceId,
        },
      });
      throw new Error("database undo failed and the compacted database was restored");
    }
    const originalRestored =
      (await pathExists(entry.originalPath)) && !(await pathExists(entry.backupPath));
    await persist(
      options,
      originalRestored
        ? {
            ...entry,
            status: "restoring",
            diagnostic: {
              severity: "error",
              code: "DATABASE_UNDO_RESUMABLE",
              message: error instanceof Error ? error.message : String(error),
              adapter: "codex",
              resourceId: entry.resourceId,
            },
          }
        : {
            ...entry,
            status: "partial",
            diagnostic: {
              severity: "error",
              code: "DATABASE_UNDO_PARTIAL",
              message: error instanceof Error ? error.message : String(error),
              adapter: "codex",
              resourceId: entry.resourceId,
            },
          },
    );
    throw error;
  }
}

export async function purgeDatabaseBackup(
  input: DatabaseBackupEntry,
  options: DatabaseRecoveryOptions,
): Promise<{ entry: DatabaseBackupEntry; reclaimedBytes: number }> {
  let entry = databaseBackupEntrySchema.parse(input);
  assertRecoveryPaths(entry, options);
  if (!["installed", "purging"].includes(entry.status)) {
    throw new Error(`database backup entry cannot be purged from ${entry.status}`);
  }
  const dependencies = options.dependencies ?? {};
  const clock = dependencies.clock ?? (() => new Date());
  await assertOffline(entry, dependencies);
  if (!(await pathExists(entry.originalPath)) || !(await pathExists(entry.backupPath))) {
    throw new Error("database purge paths do not match the recovery manifest");
  }
  const current = await (dependencies.inspectDatabase ?? inspectCodexDatabase)(
    entry.originalPath,
    dependencies,
  );
  if (current.sidecarsPresent) {
    throw new Error("database WAL or SHM companion exists; purge is refused");
  }
  await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
    entry.originalPath,
    dependencies,
  );
  await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
    entry.backupPath,
    dependencies,
  );
  const backupStats = await lstat(entry.backupPath);
  if (!backupStats.isFile() || backupStats.isSymbolicLink()) {
    throw new Error("database rollback copy is not a regular file");
  }
  entry = await persist(options, { ...entry, status: "purging" });
  let reclaimedBytes = backupStats.size;
  for (const sidecar of backupSidecars(entry)) {
    if (await pathExists(sidecar.backup)) {
      const stats = await lstat(sidecar.backup);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error("database rollback sidecar is not a regular file");
      }
      reclaimedBytes += stats.size;
      await rm(sidecar.backup);
    }
  }
  await rm(entry.backupPath);
  await syncDirectory(options.backupDirectory);
  entry = await persist(options, {
    ...entry,
    status: "purged",
    purgedAt: clock().toISOString(),
    diagnostic: undefined,
  });
  return { entry, reclaimedBytes };
}
