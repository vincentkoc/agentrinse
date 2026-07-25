import { chmod, lstat, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
import {
  acquireDatabaseExclusion,
  lockedFileIdentityMatches,
  type DatabaseExclusion,
} from "./database-exclusion.js";
import { CommandInterruptedError } from "./interruption.js";
import { exchangePaths, renameNoReplace } from "./no-clobber-rename.js";

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
  exchange?: typeof exchangePaths;
  acquireExclusion?: typeof acquireDatabaseExclusion;
  authorization?: {
    expiresAtMs: number;
    now: () => Date;
  };
};

export type ExecuteDatabaseVacuumOptions = {
  runId: string;
  entryId: string;
  backupDirectory: string;
  signal?: AbortSignal;
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

function interruptionFrom(signal?: AbortSignal): CommandInterruptedError | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }
  return signal.reason instanceof CommandInterruptedError
    ? signal.reason
    : new CommandInterruptedError("database vacuum interrupted");
}

function throwIfInterrupted(signal?: AbortSignal): void {
  const interruption = interruptionFrom(signal);
  if (interruption !== undefined) {
    throw interruption;
  }
}

function isInterruptionError(error: unknown, signal?: AbortSignal): boolean {
  return (
    error instanceof CommandInterruptedError ||
    (signal?.aborted === true &&
      (error === signal.reason || (error instanceof Error && error.name === "AbortError")))
  );
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
  allowedHandlePids: ReadonlySet<number> = new Set(),
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
  const externalPids =
    handles.status === "busy" ? handles.pids.filter((pid) => !allowedHandlePids.has(pid)) : [];
  if (handles.status === "unknown" || (handles.status === "busy" && externalPids.length !== 0)) {
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

function assertLockedIdentity(
  exclusion: DatabaseExclusion,
  path: string,
  planned: DatabaseVacuumAction["target"],
): void {
  if (!lockedFileIdentityMatches(exclusion.identities.get(path), planned)) {
    throw new DatabaseExecutionError(
      "database identity changed while acquiring exclusive access",
      "skipped-stale",
      "DATABASE_IDENTITY_CHANGED",
    );
  }
}

async function assertSidecarIdentity(
  path: string,
  planned: DatabaseVacuumAction["target"]["wal"],
  label: "WAL" | "SHM",
): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      planned === undefined
    ) {
      return;
    }
    throw new DatabaseExecutionError(
      `database ${label} identity changed while acquiring exclusive access`,
      "skipped-stale",
      "DATABASE_IDENTITY_CHANGED",
    );
  }
  if (
    planned === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.dev !== planned.device ||
    stats.ino !== planned.inode ||
    stats.mode !== planned.mode ||
    stats.mtimeMs !== planned.mtimeMs ||
    stats.size !== planned.measuredBytes ||
    (label === "WAL" && stats.size > 0)
  ) {
    throw new DatabaseExecutionError(
      `database ${label} identity changed while acquiring exclusive access`,
      "skipped-stale",
      "DATABASE_IDENTITY_CHANGED",
    );
  }
}

async function assertSidecarsStable(action: DatabaseVacuumAction): Promise<void> {
  await assertSidecarIdentity(`${action.target.path}-wal`, action.target.wal, "WAL");
  await assertSidecarIdentity(`${action.target.path}-shm`, action.target.shm, "SHM");
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
  throwIfInterrupted(options.signal);
  const dependencies: DatabaseExecutionDependencies =
    options.signal === undefined
      ? (options.dependencies ?? {})
      : { ...options.dependencies, signal: options.signal };
  const clock = dependencies.clock ?? (() => new Date());
  const rename = dependencies.rename ?? renameNoReplace;
  const exchange = dependencies.exchange ?? exchangePaths;
  const acquireExclusion = dependencies.acquireExclusion ?? acquireDatabaseExclusion;
  const inspect = dependencies.inspectDatabase ?? inspectCodexDatabase;
  const originalDirectory = dirname(action.target.path);
  const backupPath = join(
    options.backupDirectory,
    `${options.entryId}-${action.target.filename}.original`,
  );
  const backupWalPath = action.target.wal === undefined ? undefined : `${backupPath}-wal`;
  const backupShmPath = action.target.shm === undefined ? undefined : `${backupPath}-shm`;
  const temporaryDirectory = join(
    originalDirectory,
    `.${action.target.filename}.${options.entryId}.vacuum-work`,
  );
  const temporaryPath = join(temporaryDirectory, action.target.filename);
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
    (await pathExists(temporaryDirectory)) ||
    (await pathExists(manifestPath))
  ) {
    throw new DatabaseExecutionError(
      "database maintenance destination already exists",
      "failed",
      "DATABASE_DESTINATION_OCCUPIED",
    );
  }
  await ensurePrivateDirectory(temporaryDirectory);

  let entry: DatabaseBackupEntry;
  let mutationStarted = false;
  try {
    entry = await persist(
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
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await syncDirectory(originalDirectory);
    throw error;
  }

  try {
    await assertOffline(action.target.path, dependencies);
    assertAuthorized(dependencies);
    await (dependencies.vacuumInto ?? vacuumCodexDatabaseInto)(
      action.target.path,
      temporaryPath,
      dependencies,
    );
    throwIfInterrupted(options.signal);
    await chmod(temporaryPath, action.target.mode & 0o7777);
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
      compacted.identity.migrationDigest !== action.target.migrationDigest ||
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
      !isDeepStrictEqual(current.identity, action.target) ||
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

    entry = await persist(
      manifestPath,
      {
        ...entry,
        status: "installing",
        backupIdentity: current.identity,
        installedIdentity: compacted.identity,
      },
      options.backupDirectory,
    );

    let exclusion: DatabaseExclusion;
    try {
      exclusion = await acquireExclusion(
        [action.target.path, temporaryPath],
        process.platform,
        new Map([
          [action.target.path, current.identity.mode],
          [temporaryPath, compacted.identity.mode],
        ]),
      );
    } catch (error) {
      throw new DatabaseExecutionError(
        error instanceof Error ? error.message : String(error),
        "skipped-stale",
        "DATABASE_EXCLUSION_UNAVAILABLE",
        entry,
      );
    }

    let exchanged = false;
    let archived = false;
    const movedSidecars: Array<{ source: string; destination: string }> = [];
    let transitionResult: DatabaseExecutionResult | undefined;
    let transitionError: unknown;
    let transitionFailed = false;
    try {
      try {
        // Both inode locks stay held across exchange, archival, and the durable
        // manifest write so Codex can never reopen a half-transitioned layout.
        assertLockedIdentity(exclusion, action.target.path, current.identity);
        assertLockedIdentity(exclusion, temporaryPath, compacted.identity);
        await assertOffline(action.target.path, dependencies, new Set([process.pid]));
        await assertSidecarsStable(action);
        const lockedCurrent = await inspect(
          action.target.path,
          dependencies,
          action.target.path,
          action.target.path,
          exclusion.handles?.get(action.target.path),
        );
        const lockedCompacted = await inspect(
          temporaryPath,
          dependencies,
          action.target.path,
          action.target.path,
          exclusion.handles?.get(temporaryPath),
        );
        if (
          lockedCurrent.identity.fingerprint !== current.identity.fingerprint ||
          lockedCompacted.identity.fingerprint !== compacted.identity.fingerprint
        ) {
          throw new DatabaseExecutionError(
            "database content changed while acquiring the atomic swap boundary",
            "skipped-stale",
            "DATABASE_IDENTITY_CHANGED",
            entry,
          );
        }
        assertAuthorized(dependencies);
        throwIfInterrupted(options.signal);

        await exchange(action.target.path, temporaryPath);
        exchanged = true;
        mutationStarted = true;
        if (action.target.wal !== undefined && backupWalPath !== undefined) {
          const source = `${action.target.path}-wal`;
          await rename(source, backupWalPath);
          movedSidecars.push({ source, destination: backupWalPath });
        }
        if (action.target.shm !== undefined && backupShmPath !== undefined) {
          const source = `${action.target.path}-shm`;
          await rename(source, backupShmPath);
          movedSidecars.push({ source, destination: backupShmPath });
        }
        await rename(temporaryPath, backupPath);
        archived = true;
        await syncDirectory(originalDirectory);
        await syncDirectory(options.backupDirectory);
        await rm(temporaryDirectory, { recursive: true, force: true });
        await syncDirectory(originalDirectory);
        entry = await persist(
          manifestPath,
          {
            ...entry,
            status: "installed",
          },
          options.backupDirectory,
        );
        transitionResult = {
          backupEntryId: entry.entryId,
          backupPath: entry.backupPath,
          originalBytes: action.target.measuredBytes,
          compactedBytes: compacted.identity.measuredBytes,
          retainedBackupBytes:
            action.target.measuredBytes +
            (action.target.wal?.measuredBytes ?? 0) +
            (action.target.shm?.measuredBytes ?? 0),
          reclaimedBytes: 0,
        };
      } catch (installError) {
        if (isInterruptionError(installError, options.signal) && !exchanged) {
          throw interruptionFrom(options.signal) ?? installError;
        }
        try {
          if (
            installError instanceof DatabaseExecutionError &&
            installError.outcome === "skipped-stale" &&
            !exchanged
          ) {
            throw installError;
          }
          if (archived) {
            await exchange(action.target.path, backupPath);
            await rm(backupPath);
          } else if (exchanged) {
            await exchange(action.target.path, temporaryPath);
          }
          for (const sidecar of movedSidecars.reverse()) {
            if (!(await pathExists(sidecar.source)) && (await pathExists(sidecar.destination))) {
              await rename(sidecar.destination, sidecar.source);
            }
          }
          await syncDirectory(originalDirectory);
          await syncDirectory(options.backupDirectory);
          await rm(temporaryDirectory, { recursive: true, force: true });
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
                message:
                  installError instanceof Error ? installError.message : String(installError),
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
      transitionFailed = true;
      transitionError = error;
    }

    try {
      await exclusion.release();
    } catch (releaseError) {
      const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
      try {
        entry = await persist(
          manifestPath,
          {
            ...entry,
            status: "partial",
            diagnostic: {
              severity: "error",
              code: "DATABASE_EXCLUSION_RELEASE_PARTIAL",
              message,
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          },
          options.backupDirectory,
        );
      } catch {
        // The run journal still receives the last durable manifest identity.
      }
      throw new DatabaseExecutionError(
        "database exclusion could not be fully released; recovery is required",
        "partially-applied",
        "DATABASE_EXCLUSION_RELEASE_PARTIAL",
        entry,
      );
    }
    if (transitionFailed) {
      throw transitionError;
    }
    return transitionResult!;
  } catch (error) {
    if (isInterruptionError(error, options.signal)) {
      const sourceExists = await pathExists(action.target.path).catch(() => false);
      const backupExists = await pathExists(backupPath).catch(() => false);
      if (sourceExists && !backupExists) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        await syncDirectory(originalDirectory);
        entry = await persist(
          manifestPath,
          {
            ...entry,
            status: "restored",
            restoredAt: clock().toISOString(),
            diagnostic: {
              severity: "warning",
              code: "COMMAND_INTERRUPTED",
              message: "database vacuum was interrupted before the atomic swap",
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          },
          options.backupDirectory,
        );
      }
      throw interruptionFrom(options.signal) ?? error;
    }
    if (
      !mutationStarted &&
      !(error instanceof DatabaseExecutionError && error.outcome === "partially-applied")
    ) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      await syncDirectory(originalDirectory);
      const executionError = error instanceof DatabaseExecutionError ? error : undefined;
      const diagnosticCode = executionError?.diagnosticCode ?? "DATABASE_VACUUM_FAILED";
      entry = await persist(
        manifestPath,
        {
          ...entry,
          status: "restored",
          restoredAt: clock().toISOString(),
          diagnostic: {
            severity: executionError?.outcome === "skipped-stale" ? "warning" : "error",
            code: diagnosticCode,
            message: error instanceof Error ? error.message : String(error),
            adapter: action.adapter,
            resourceId: action.resourceId,
          },
        },
        options.backupDirectory,
      );
      throw new DatabaseExecutionError(
        error instanceof Error ? error.message : String(error),
        executionError?.outcome ?? "failed",
        diagnosticCode,
        entry,
      );
    }
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
