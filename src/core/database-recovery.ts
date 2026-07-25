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
import type { DatabaseIdentity, DatabaseSidecarIdentity } from "../contracts/action.js";
import { syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import {
  acquireDatabaseExclusion,
  lockedFileIdentityMatches,
  type DatabaseExclusion,
} from "./database-exclusion.js";
import { exchangePaths, renameNoReplace } from "./no-clobber-rename.js";

export type DatabaseRecoveryDependencies = CodexDatabaseDependencies & {
  clock?: () => Date;
  inspectDatabase?: typeof inspectCodexDatabase;
  inspectProcesses?: typeof inspectCodexProcesses;
  inspectOpenHandles?: typeof inspectDatabaseOpenHandles;
  verifyIntegrity?: typeof verifyCodexDatabaseIntegrity;
  rename?: typeof renameNoReplace;
  exchange?: typeof exchangePaths;
  acquireExclusion?: typeof acquireDatabaseExclusion;
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
    `.${entry.target.filename}.${entry.entryId}.vacuum-work`,
    entry.target.filename,
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
  allowedHandlePids: ReadonlySet<number> = new Set(),
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
    const externalPids =
      handles.status === "busy" ? handles.pids.filter((pid) => !allowedHandlePids.has(pid)) : [];
    if (handles.status === "unknown" || (handles.status === "busy" && externalPids.length !== 0)) {
      throw new Error(
        handles.status === "busy"
          ? `a process has a database recovery path open: ${path}`
          : `database descriptor state is unknown: ${handles.reason}`,
      );
    }
  }
}

function assertLockedIdentity(
  exclusion: DatabaseExclusion,
  path: string,
  identity: DatabaseIdentity,
): void {
  if (!lockedFileIdentityMatches(exclusion.identities.get(path), identity)) {
    throw new Error(`database identity changed while acquiring exclusive access: ${path}`);
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

async function sidecarMatches(path: string, planned: DatabaseSidecarIdentity): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      stats.dev === planned.device &&
      stats.ino === planned.inode &&
      stats.mode === planned.mode &&
      stats.mtimeMs === planned.mtimeMs &&
      stats.size === planned.measuredBytes
    );
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

async function assertRecoverableSidecars(entry: DatabaseBackupEntry): Promise<void> {
  for (const sidecar of [
    {
      planned: entry.target.wal,
      canonical: `${entry.originalPath}-wal`,
      backup: entry.backupWalPath,
      label: "WAL",
    },
    {
      planned: entry.target.shm,
      canonical: `${entry.originalPath}-shm`,
      backup: entry.backupShmPath,
      label: "SHM",
    },
  ]) {
    const canonicalExists = await pathExists(sidecar.canonical);
    const backupExists = sidecar.backup === undefined ? false : await pathExists(sidecar.backup);
    if (sidecar.planned === undefined) {
      if (canonicalExists || backupExists) {
        throw new Error(`unexpected database ${sidecar.label} appeared during recovery`);
      }
      continue;
    }
    if (canonicalExists === backupExists) {
      throw new Error(`database ${sidecar.label} recovery location is ambiguous`);
    }
    const path = canonicalExists ? sidecar.canonical : sidecar.backup!;
    if (!(await sidecarMatches(path, sidecar.planned))) {
      throw new Error(`database ${sidecar.label} no longer matches the recovery manifest`);
    }
  }
}

async function assertPurgeSidecars(entry: DatabaseBackupEntry): Promise<void> {
  for (const sidecar of [
    {
      planned: entry.target.wal,
      canonical: `${entry.originalPath}-wal`,
      backup: entry.backupWalPath,
      label: "WAL",
    },
    {
      planned: entry.target.shm,
      canonical: `${entry.originalPath}-shm`,
      backup: entry.backupShmPath,
      label: "SHM",
    },
  ]) {
    if (await pathExists(sidecar.canonical)) {
      throw new Error(`database ${sidecar.label} appeared at the canonical purge path`);
    }
    if (sidecar.backup === undefined) {
      continue;
    }
    const backupExists = await pathExists(sidecar.backup);
    if (!backupExists) {
      if (entry.status === "purging") {
        continue;
      }
      throw new Error(`database ${sidecar.label} rollback copy is missing`);
    }
    if (sidecar.planned === undefined || !(await sidecarMatches(sidecar.backup, sidecar.planned))) {
      throw new Error(`database ${sidecar.label} no longer matches the purge manifest`);
    }
  }
}

async function removeTemporaryWorkspace(entry: DatabaseBackupEntry): Promise<void> {
  await rm(dirname(entry.temporaryPath), { recursive: true, force: true });
  await syncDirectory(dirname(entry.originalPath));
}

function movedSidecarMatches(
  actual: DatabaseSidecarIdentity | undefined,
  planned: DatabaseSidecarIdentity | undefined,
): boolean {
  return (
    (actual === undefined && planned === undefined) ||
    (actual !== undefined &&
      planned !== undefined &&
      actual.device === planned.device &&
      actual.inode === planned.inode &&
      actual.mode === planned.mode &&
      actual.mtimeMs === planned.mtimeMs &&
      actual.measuredBytes === planned.measuredBytes)
  );
}

function databaseMainIdentityMatches(actual: DatabaseIdentity, planned: DatabaseIdentity): boolean {
  return (
    actual.database === planned.database &&
    actual.filename === planned.filename &&
    actual.device === planned.device &&
    actual.inode === planned.inode &&
    actual.mode === planned.mode &&
    actual.mtimeMs === planned.mtimeMs &&
    actual.measuredBytes === planned.measuredBytes &&
    actual.pageSize === planned.pageSize &&
    actual.pageCount === planned.pageCount &&
    actual.freelistCount === planned.freelistCount &&
    actual.journalMode === planned.journalMode &&
    actual.autoVacuum === planned.autoVacuum &&
    actual.migrationVersion === planned.migrationVersion &&
    actual.migrationDigest === planned.migrationDigest &&
    actual.tables.join("\0") === planned.tables.join("\0") &&
    actual.schemaDigest === planned.schemaDigest
  );
}

function movedOriginalMatches(actual: DatabaseIdentity, planned: DatabaseIdentity): boolean {
  return (
    databaseMainIdentityMatches(actual, planned) &&
    movedSidecarMatches(actual.wal, planned.wal) &&
    movedSidecarMatches(actual.shm, planned.shm)
  );
}

async function verifyRetainedOriginal(
  entry: DatabaseBackupEntry,
  dependencies: DatabaseRecoveryDependencies,
  inspect: typeof inspectCodexDatabase,
): Promise<DatabaseIdentity> {
  await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
    entry.backupPath,
    dependencies,
  );
  const backup = await inspect(entry.backupPath, dependencies, entry.originalPath);
  const matches = movedOriginalMatches(backup.identity, entry.backupIdentity ?? entry.target);
  if (!matches || (backup.identity.wal?.measuredBytes ?? 0) > 0) {
    throw new Error("the retained original database no longer matches its recovery manifest");
  }
  return backup.identity;
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
  const exchange = dependencies.exchange ?? exchangePaths;
  const acquireExclusion = dependencies.acquireExclusion ?? acquireDatabaseExclusion;
  const inspect = dependencies.inspectDatabase ?? inspectCodexDatabase;
  await assertOffline(entry, dependencies);

  const originalExists = await pathExists(entry.originalPath);
  const backupExists = await pathExists(entry.backupPath);
  const temporaryExists = await pathExists(entry.temporaryPath);

  if (entry.status === "preparing") {
    if (!originalExists || backupExists) {
      throw new Error("interrupted database preparation has ambiguous file state");
    }
    await restoreSidecars(entry, rename);
    if (temporaryExists) {
      await removeTemporaryWorkspace(entry);
    }
    return markRestored(options, entry, clock);
  }

  if (entry.status === "vacuumed") {
    if (originalExists && !backupExists) {
      await restoreSidecars(entry, rename);
      if (temporaryExists) {
        await removeTemporaryWorkspace(entry);
      }
      return markRestored(options, entry, clock);
    }
    throw new Error("interrupted database vacuum has ambiguous file state");
  }

  if (entry.status === "installing" || entry.status === "partial") {
    if (originalExists && backupExists && !temporaryExists) {
      entry = await persist(options, { ...entry, status: "installed" });
    }
    if (originalExists && !backupExists && temporaryExists) {
      const original = await inspect(entry.originalPath, dependencies);
      if (databaseMainIdentityMatches(original.identity, entry.target)) {
        const temporary = await inspect(
          entry.temporaryPath,
          dependencies,
          entry.originalPath,
          entry.originalPath,
        );
        if (
          entry.installedIdentity === undefined ||
          !databaseMainIdentityMatches(temporary.identity, entry.installedIdentity)
        ) {
          throw new Error("interrupted database exchange no longer contains the compacted copy");
        }
        const exclusion = await acquireExclusion(
          [entry.originalPath, entry.temporaryPath],
          process.platform,
          new Map([
            [entry.originalPath, original.identity.mode],
            [entry.temporaryPath, temporary.identity.mode],
          ]),
        );
        try {
          assertLockedIdentity(exclusion, entry.originalPath, original.identity);
          assertLockedIdentity(exclusion, entry.temporaryPath, temporary.identity);
          await assertOffline(entry, dependencies, new Set([process.pid]));
          await assertRecoverableSidecars(entry);
          await restoreSidecars(entry, rename);
          await removeTemporaryWorkspace(entry);
          return markRestored(options, entry, clock);
        } finally {
          await exclusion.release();
        }
      }
      if (
        entry.installedIdentity === undefined ||
        !databaseMainIdentityMatches(original.identity, entry.installedIdentity)
      ) {
        throw new Error(
          "the compacted database changed after interrupted installation; automatic undo is no longer safe",
        );
      }
      const temporary = await inspect(
        entry.temporaryPath,
        dependencies,
        entry.originalPath,
        entry.originalPath,
      );
      if (!databaseMainIdentityMatches(temporary.identity, entry.target)) {
        throw new Error("interrupted database exchange no longer contains the planned original");
      }
      const exclusion = await acquireExclusion(
        [entry.originalPath, entry.temporaryPath],
        process.platform,
        new Map([
          [entry.originalPath, original.identity.mode],
          [entry.temporaryPath, temporary.identity.mode],
        ]),
      );
      try {
        assertLockedIdentity(exclusion, entry.originalPath, original.identity);
        assertLockedIdentity(exclusion, entry.temporaryPath, temporary.identity);
        await assertOffline(entry, dependencies, new Set([process.pid]));
        await assertRecoverableSidecars(entry);
        await exchange(entry.originalPath, entry.temporaryPath);
        await restoreSidecars(entry, rename);
        await removeTemporaryWorkspace(entry);
        return markRestored(options, entry, clock);
      } finally {
        await exclusion.release();
      }
    }
    if (["installing", "partial"].includes(entry.status)) {
      throw new Error("interrupted database installation has ambiguous file state");
    }
  }

  if (!["installed", "restoring"].includes(entry.status)) {
    throw new Error(`database backup entry cannot be restored from ${entry.status}`);
  }

  const currentOriginalExists = await pathExists(entry.originalPath);
  const currentBackupExists = await pathExists(entry.backupPath);
  const currentTemporaryExists = await pathExists(entry.temporaryPath);

  if (entry.status === "restoring") {
    if (currentOriginalExists && !currentBackupExists && !currentTemporaryExists) {
      const restored = await inspect(entry.originalPath, dependencies);
      if (!databaseMainIdentityMatches(restored.identity, entry.target)) {
        throw new Error("interrupted database restore no longer matches the retained original");
      }
      const exclusion = await acquireExclusion(
        [entry.originalPath],
        process.platform,
        new Map([[entry.originalPath, restored.identity.mode]]),
      );
      try {
        assertLockedIdentity(exclusion, entry.originalPath, restored.identity);
        await assertOffline(entry, dependencies, new Set([process.pid]));
        await assertRecoverableSidecars(entry);
        await restoreSidecars(entry, rename);
        return markRestored(options, entry, clock);
      } finally {
        await exclusion.release();
      }
    }
    if (!(currentOriginalExists && currentBackupExists && !currentTemporaryExists)) {
      throw new Error("interrupted database restore has ambiguous file state");
    }
    const restored = await inspect(entry.originalPath, dependencies);
    const displaced = await inspect(
      entry.backupPath,
      dependencies,
      entry.originalPath,
      entry.originalPath,
    );
    if (
      databaseMainIdentityMatches(restored.identity, entry.target) &&
      entry.installedIdentity !== undefined &&
      databaseMainIdentityMatches(displaced.identity, entry.installedIdentity)
    ) {
      const exclusion = await acquireExclusion(
        [entry.originalPath, entry.backupPath],
        process.platform,
        new Map([
          [entry.originalPath, restored.identity.mode],
          [entry.backupPath, displaced.identity.mode],
        ]),
      );
      try {
        assertLockedIdentity(exclusion, entry.originalPath, restored.identity);
        assertLockedIdentity(exclusion, entry.backupPath, displaced.identity);
        await assertOffline(entry, dependencies, new Set([process.pid]));
        await assertRecoverableSidecars(entry);
        await restoreSidecars(entry, rename);
        await rm(entry.backupPath);
        await syncDirectory(options.backupDirectory);
        return markRestored(options, entry, clock);
      } finally {
        await exclusion.release();
      }
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
  const backupIdentity = await verifyRetainedOriginal(entry, dependencies, inspect);
  await assertOffline(entry, dependencies);
  const boundaryInstalled = await inspect(entry.originalPath, dependencies);
  if (
    entry.installedIdentity === undefined ||
    boundaryInstalled.identity.fingerprint !== entry.installedIdentity.fingerprint ||
    boundaryInstalled.sidecarsPresent
  ) {
    throw new Error(
      "the compacted database changed before the restore boundary; automatic undo is no longer safe",
    );
  }
  entry = await persist(options, { ...entry, status: "restoring", backupIdentity });
  const exclusion = await acquireExclusion(
    [entry.originalPath, entry.backupPath],
    process.platform,
    new Map([
      [entry.originalPath, boundaryInstalled.identity.mode],
      [entry.backupPath, backupIdentity.mode],
    ]),
  );
  let exchanged = false;
  try {
    // Keep both inodes excluded until the restored layout and manifest agree;
    // a crash before then is resumed from exact identities above.
    assertLockedIdentity(exclusion, entry.originalPath, boundaryInstalled.identity);
    assertLockedIdentity(exclusion, entry.backupPath, backupIdentity);
    await assertOffline(entry, dependencies, new Set([process.pid]));
    await assertRecoverableSidecars(entry);
    await exchange(entry.originalPath, entry.backupPath);
    exchanged = true;
    await restoreSidecars(entry, rename);
    await syncDirectory(dirname(entry.originalPath));
    await rm(entry.backupPath);
    await syncDirectory(options.backupDirectory);
    return markRestored(options, entry, clock);
  } catch (error) {
    await persist(options, {
      ...entry,
      status: "restoring",
      diagnostic: {
        severity: "error",
        code: exchanged ? "DATABASE_UNDO_RESUMABLE" : "DATABASE_UNDO_BLOCKED",
        message: error instanceof Error ? error.message : String(error),
        adapter: "codex",
        resourceId: entry.resourceId,
      },
    });
    throw error;
  } finally {
    await exclusion.release();
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
  const acquireExclusion = dependencies.acquireExclusion ?? acquireDatabaseExclusion;
  const inspect = dependencies.inspectDatabase ?? inspectCodexDatabase;
  await assertOffline(entry, dependencies);
  const originalExists = await pathExists(entry.originalPath);
  const backupExists = await pathExists(entry.backupPath);
  if (!originalExists || (entry.status === "installed" && !backupExists)) {
    throw new Error("database purge paths do not match the recovery manifest");
  }
  const current = await inspect(entry.originalPath, dependencies);
  if (current.sidecarsPresent) {
    throw new Error("database WAL or SHM companion exists; purge is refused");
  }
  await (dependencies.verifyIntegrity ?? verifyCodexDatabaseIntegrity)(
    entry.originalPath,
    dependencies,
  );
  let reclaimedBytes = 0;
  let backupIdentity: DatabaseIdentity | undefined;
  if (backupExists) {
    backupIdentity = await verifyRetainedOriginal(entry, dependencies, inspect);
    const backupStats = await lstat(entry.backupPath);
    if (!backupStats.isFile() || backupStats.isSymbolicLink()) {
      throw new Error("database rollback copy is not a regular file");
    }
    reclaimedBytes += backupStats.size;
  }
  const exclusionPaths = [
    entry.originalPath,
    ...(backupIdentity === undefined ? [] : [entry.backupPath]),
  ];
  const exclusion = await acquireExclusion(
    exclusionPaths,
    process.platform,
    new Map([
      [entry.originalPath, current.identity.mode],
      ...(backupIdentity === undefined
        ? []
        : ([[entry.backupPath, backupIdentity.mode]] as Array<[string, number]>)),
    ]),
  );
  try {
    assertLockedIdentity(exclusion, entry.originalPath, current.identity);
    if (backupIdentity !== undefined) {
      assertLockedIdentity(exclusion, entry.backupPath, backupIdentity);
    }
    await assertOffline(entry, dependencies, new Set([process.pid]));
    await assertPurgeSidecars(entry);
    entry = await persist(options, { ...entry, status: "purging" });
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
    if (await pathExists(entry.backupPath)) {
      await rm(entry.backupPath);
    }
    await syncDirectory(options.backupDirectory);
    entry = await persist(options, {
      ...entry,
      status: "purged",
      purgedAt: clock().toISOString(),
      diagnostic: undefined,
    });
    return { entry, reclaimedBytes };
  } finally {
    await exclusion.release();
  }
}
