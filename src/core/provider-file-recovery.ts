import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  providerFileQuarantineEntrySchema,
  type ProviderFileQuarantineEntry,
} from "../contracts/provider-file-quarantine.js";
import { syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import {
  inspectProviderFile,
  providerFileIdentityMatches,
  providerFileStatsMatch,
} from "./provider-file-identity.js";
import { providerFileQuarantinePath } from "./provider-file-executor.js";
import { inspectProviderProcesses, type ProviderProcessResult } from "./provider-processes.js";
import { findProcessesUsingFile, type ProcessOwnershipResult } from "./process-ownership.js";

export type ProviderFileRecoveryDependencies = {
  clock?: () => Date;
  move?: (source: string, destination: string) => Promise<void>;
  inspectProcesses?: (
    provider: ProviderFileQuarantineEntry["target"]["provider"],
  ) => Promise<ProviderProcessResult>;
  inspectOpenHandles?: (path: string) => Promise<ProcessOwnershipResult>;
  truncateHandle?: (handle: FileHandle) => Promise<void>;
  platform?: NodeJS.Platform;
};

export type ProviderFileRecoveryOptions = {
  manifestPath: string;
  quarantineDirectory: string;
  allowUnexpired?: boolean;
  dependencies?: ProviderFileRecoveryDependencies;
};

export function providerFilePurgeIsolationPath(
  quarantineDirectory: string,
  entryId: string,
): string {
  return join(quarantineDirectory, `${entryId}.payload.purging`);
}

const EMPTY_FILE_SHA256 = createHash("sha256").digest("hex");

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function openValidatedFile(
  path: string,
  identity: ProviderFileQuarantineEntry["target"],
  allowSealedMode = false,
): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`provider-file recovery target is not a regular file: ${path}`);
    }
    if (!providerFileStatsMatch(stats, identity, allowSealedMode)) {
      throw new Error(`provider-file descriptor identity changed: ${path}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openValidatedWritableFile(
  path: string,
  identity: ProviderFileQuarantineEntry["target"],
  readHandle: FileHandle,
): Promise<FileHandle> {
  const openWritable = () =>
    open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let writeHandle: FileHandle | undefined;
  let modeAdjusted = false;
  try {
    try {
      writeHandle = await openWritable();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        throw error;
      }
      await readHandle.chmod((identity.mode & 0o7777) | 0o200);
      await readHandle.sync();
      modeAdjusted = true;
      writeHandle = await openWritable();
    }
    const writableMode = modeAdjusted ? identity.mode | 0o200 : identity.mode;
    if (!providerFileStatsMatch(await writeHandle.stat(), { ...identity, mode: writableMode })) {
      throw new Error(`provider-file writable descriptor identity changed: ${path}`);
    }
    await readHandle.chmod(identity.mode & ~0o222);
    await readHandle.sync();
    if (
      !providerFileStatsMatch(await readHandle.stat(), identity, true) ||
      !providerFileStatsMatch(await writeHandle.stat(), identity, true)
    ) {
      throw new Error(`provider-file descriptor identity changed while sealing purge: ${path}`);
    }
    return writeHandle;
  } catch (error) {
    await writeHandle?.close().catch(() => undefined);
    if (modeAdjusted) {
      await readHandle.chmod(identity.mode & 0o7777).catch(() => undefined);
      await readHandle.sync().catch(() => undefined);
    }
    throw error;
  }
}

async function restoreValidatedMode(
  path: string,
  identity: ProviderFileQuarantineEntry["target"],
): Promise<void> {
  const handle = await openValidatedFile(path, identity, true);
  try {
    await handle.chmod(identity.mode & 0o7777);
    await handle.sync();
    if (!providerFileStatsMatch(await handle.stat(), identity)) {
      throw new Error(`provider-file mode repair changed descriptor identity: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

function assertOwnedPaths(
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): void {
  const expectedManifest = join(options.quarantineDirectory, `${entry.entryId}.json`);
  const expectedPayload = providerFileQuarantinePath(options.quarantineDirectory, entry.entryId);
  if (
    resolve(options.manifestPath) !== resolve(expectedManifest) ||
    resolve(entry.quarantinePath) !== resolve(expectedPayload) ||
    resolve(entry.originalPath) !== resolve(entry.target.path)
  ) {
    throw new Error("provider-file recovery manifest contains paths outside its owned set");
  }
}

async function persist(
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry> {
  const parsed = providerFileQuarantineEntrySchema.parse(entry);
  assertOwnedPaths(parsed, options);
  await writeJsonAtomic(options.manifestPath, parsed, {
    privateDirectories: [options.quarantineDirectory],
  });
  return parsed;
}

function movedIdentityMatches(
  actual: ProviderFileQuarantineEntry["target"],
  entry: ProviderFileQuarantineEntry,
): boolean {
  const expected = entry.target;
  return (
    actual.provider === expected.provider &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.linkCount === expected.linkCount &&
    (actual.mode === expected.mode || actual.mode === (expected.mode & ~0o222)) &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.measuredBytes === expected.measuredBytes &&
    actual.contentSha256 === expected.contentSha256
  );
}

function purgedMarkerMatches(
  actual: ProviderFileQuarantineEntry["target"],
  entry: ProviderFileQuarantineEntry,
): boolean {
  const expected = entry.target;
  return (
    actual.provider === expected.provider &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.linkCount === expected.linkCount &&
    actual.mode === (expected.mode & ~0o222) &&
    actual.measuredBytes === 0 &&
    actual.contentSha256 === EMPTY_FILE_SHA256
  );
}

async function inspectOriginal(
  entry: ProviderFileQuarantineEntry,
): Promise<ProviderFileQuarantineEntry["target"] | undefined> {
  if (!(await pathExists(entry.originalPath))) {
    return undefined;
  }
  return inspectProviderFile(entry.originalPath, entry.target.ownerRoot, entry.target.provider);
}

async function inspectQuarantine(
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry["target"] | undefined> {
  return inspectPayload(entry.quarantinePath, entry, options);
}

async function inspectPurgeIsolation(
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry["target"] | undefined> {
  return inspectPayload(
    providerFilePurgeIsolationPath(options.quarantineDirectory, entry.entryId),
    entry,
    options,
  );
}

async function inspectPayload(
  path: string,
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry["target"] | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return inspectProviderFile(path, options.quarantineDirectory, entry.target.provider);
}

async function reconcile(
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry> {
  assertOwnedPaths(entry, options);
  const [original, quarantine, purgeIsolation] = await Promise.all([
    inspectOriginal(entry),
    inspectQuarantine(entry, options),
    inspectPurgeIsolation(entry, options),
  ]);
  const occupiedPathCount = [original, quarantine, purgeIsolation].filter(
    (identity) => identity !== undefined,
  ).length;
  if (occupiedPathCount > 1) {
    throw new Error("provider-file recovery state is ambiguous: multiple paths are occupied");
  }
  if (occupiedPathCount === 0) {
    if (entry.status === "purging" || entry.status === "purged") {
      return persist(
        {
          ...entry,
          status: "purged",
          purgedAt:
            entry.purgedAt ?? (options.dependencies?.clock ?? (() => new Date()))().toISOString(),
        },
        options,
      );
    }
    throw new Error("provider-file recovery state is ambiguous: both paths are missing");
  }
  if (original !== undefined) {
    if (!providerFileIdentityMatches(original, entry.target, true)) {
      throw new Error("provider-file original path no longer matches the recovery manifest");
    }
    await assertOffline(entry, entry.originalPath, options.dependencies ?? {});
    await restoreValidatedMode(entry.originalPath, entry.target);
    if (["preparing", "restoring", "restored"].includes(entry.status)) {
      return persist(
        {
          ...entry,
          status: "restored",
          restoredAt:
            entry.restoredAt ?? (options.dependencies?.clock ?? (() => new Date()))().toISOString(),
          diagnostic: undefined,
        },
        options,
      );
    }
    throw new Error("provider-file recovery found unexpected content at the original path");
  }
  if (purgeIsolation !== undefined) {
    if (
      ["purging", "purged"].includes(entry.status) &&
      purgedMarkerMatches(purgeIsolation, entry)
    ) {
      return persist(
        {
          ...entry,
          status: "purged",
          purgedAt:
            entry.purgedAt ?? (options.dependencies?.clock ?? (() => new Date()))().toISOString(),
          quarantineIdentity: purgeIsolation,
          diagnostic: undefined,
        },
        options,
      );
    }
    if (entry.status !== "purging" || !movedIdentityMatches(purgeIsolation, entry)) {
      throw new Error("provider-file purge isolation payload does not match its manifest");
    }
    return persist(
      {
        ...entry,
        status: "purging",
        quarantineIdentity: purgeIsolation,
      },
      options,
    );
  }
  if (quarantine === undefined || !movedIdentityMatches(quarantine, entry)) {
    throw new Error("provider-file quarantine payload no longer matches the recovery manifest");
  }
  if (["preparing", "quarantined", "restoring", "purging", "partial"].includes(entry.status)) {
    return persist(
      {
        ...entry,
        status: ["restoring", "purging"].includes(entry.status) ? entry.status : "quarantined",
        quarantineIdentity: quarantine,
      },
      options,
    );
  }
  return entry;
}

async function assertOffline(
  entry: ProviderFileQuarantineEntry,
  path: string,
  dependencies: ProviderFileRecoveryDependencies,
): Promise<void> {
  const processes = await (dependencies.inspectProcesses ?? inspectProviderProcesses)(
    entry.target.provider,
  );
  if (processes.status !== "idle") {
    throw new Error(
      processes.status === "busy"
        ? `${entry.target.provider} is running; provider-file recovery is refused`
        : `${entry.target.provider} process state is unknown: ${processes.reason}`,
    );
  }
  const handles = await (dependencies.inspectOpenHandles ?? findProcessesUsingFile)(path);
  if (handles.status !== "idle") {
    throw new Error(
      handles.status === "busy"
        ? "a process has the provider-file recovery path open"
        : `provider-file descriptor state is unknown: ${handles.reason}`,
    );
  }
}

export async function undoProviderFileQuarantine(
  input: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry> {
  const dependencies = options.dependencies ?? {};
  const clock = dependencies.clock ?? (() => new Date());
  const move =
    dependencies.move ??
    ((source: string, destination: string) =>
      renameNoReplace(source, destination, dependencies.platform ?? process.platform));
  let entry = await reconcile(providerFileQuarantineEntrySchema.parse(input), options);
  if (entry.status === "restored") {
    return entry;
  }
  if (
    entry.status !== "quarantined" &&
    entry.status !== "restoring" &&
    entry.status !== "partial"
  ) {
    throw new Error(`provider-file quarantine entry cannot be restored from ${entry.status}`);
  }
  await assertOffline(entry, entry.quarantinePath, dependencies);
  const sourceHandle = await openValidatedFile(
    entry.quarantinePath,
    entry.quarantineIdentity,
    true,
  );
  try {
    await sourceHandle.chmod(entry.target.mode & ~0o222);
    await sourceHandle.sync();
    if (!providerFileStatsMatch(await sourceHandle.stat(), entry.target, true)) {
      throw new Error("provider-file payload changed while it was sealed for restore");
    }
    entry = await persist(
      { ...entry, status: "restoring", quarantineIdentity: entry.quarantineIdentity },
      options,
    );
    await move(entry.quarantinePath, entry.originalPath);
    if (!providerFileStatsMatch(await lstat(entry.originalPath), entry.target, true)) {
      await move(entry.originalPath, entry.quarantinePath);
      throw new Error("provider-file restore pathname changed before the atomic move");
    }
    await Promise.all([
      syncDirectory(dirname(entry.originalPath)),
      syncDirectory(options.quarantineDirectory),
    ]);
    const sealedRestored = await inspectProviderFile(
      entry.originalPath,
      entry.target.ownerRoot,
      entry.target.provider,
    );
    if (!providerFileIdentityMatches(sealedRestored, entry.target, true)) {
      throw new Error("restored provider file no longer matches the recovery manifest");
    }
    await sourceHandle.chmod(entry.target.mode & 0o7777);
    await sourceHandle.sync();
    if (
      !providerFileStatsMatch(await sourceHandle.stat(), entry.target) ||
      !providerFileStatsMatch(await lstat(entry.originalPath), entry.target)
    ) {
      throw new Error("restored provider file mode changed before recovery completed");
    }
  } finally {
    await sourceHandle.close();
  }
  return persist(
    {
      ...entry,
      status: "restored",
      restoredAt: clock().toISOString(),
      diagnostic: undefined,
    },
    options,
  );
}

export async function purgeProviderFileQuarantine(
  input: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<{ entry: ProviderFileQuarantineEntry; reclaimedBytes: number }> {
  const dependencies = options.dependencies ?? {};
  const clock = dependencies.clock ?? (() => new Date());
  const move =
    dependencies.move ??
    ((source: string, destination: string) =>
      renameNoReplace(source, destination, dependencies.platform ?? process.platform));
  let entry = await reconcile(providerFileQuarantineEntrySchema.parse(input), options);
  if (entry.status === "purged") {
    return { entry, reclaimedBytes: 0 };
  }
  if (entry.status !== "quarantined" && entry.status !== "purging") {
    throw new Error(`provider-file quarantine entry cannot be purged from ${entry.status}`);
  }
  if (!options.allowUnexpired && Date.parse(entry.expiresAt) > clock().getTime()) {
    throw new Error(`provider-file quarantine entry has not expired: ${entry.entryId}`);
  }
  const purgeIsolationPath = providerFilePurgeIsolationPath(
    options.quarantineDirectory,
    entry.entryId,
  );
  const alreadyIsolated = await pathExists(purgeIsolationPath);
  const payloadPath = alreadyIsolated ? purgeIsolationPath : entry.quarantinePath;
  await assertOffline(entry, payloadPath, dependencies);
  const payloadHandle = await openValidatedFile(payloadPath, entry.quarantineIdentity, true);
  let writableHandle: FileHandle | undefined;
  try {
    writableHandle = await openValidatedWritableFile(payloadPath, entry.target, payloadHandle);
    entry = await persist(
      { ...entry, status: "purging", quarantineIdentity: entry.quarantineIdentity },
      options,
    );
    if (!alreadyIsolated) {
      await move(entry.quarantinePath, purgeIsolationPath);
      if (
        !providerFileStatsMatch(await lstat(purgeIsolationPath), entry.target, true) ||
        !providerFileStatsMatch(await payloadHandle.stat(), entry.target, true)
      ) {
        let rollbackError: unknown;
        try {
          await move(purgeIsolationPath, entry.quarantinePath);
          await syncDirectory(options.quarantineDirectory);
        } catch (error) {
          rollbackError = error;
        }
        if (rollbackError !== undefined) {
          throw new AggregateError(
            [new Error("provider-file purge claimed an unexpected inode"), rollbackError],
            "provider-file purge claim rollback failed",
          );
        }
        throw new Error(
          "provider-file purge pathname changed before the atomic claim; the unexpected inode was restored",
        );
      }
      await syncDirectory(options.quarantineDirectory);
    }
    await (dependencies.truncateHandle ?? ((handle: FileHandle) => handle.truncate(0)))(
      writableHandle,
    );
    await writableHandle.sync();
    const truncatedStats = await writableHandle.stat();
    if (
      !truncatedStats.isFile() ||
      truncatedStats.dev !== entry.target.device ||
      truncatedStats.ino !== entry.target.inode ||
      truncatedStats.nlink !== entry.target.linkCount ||
      truncatedStats.size !== 0
    ) {
      throw new Error("provider-file purge did not truncate the claimed inode");
    }
    const purgedMarker = await inspectProviderFile(
      purgeIsolationPath,
      options.quarantineDirectory,
      entry.target.provider,
    );
    if (!purgedMarkerMatches(purgedMarker, entry)) {
      throw new Error("provider-file purge marker no longer names the claimed inode");
    }
    entry = await persist(
      {
        ...entry,
        status: "purged",
        purgedAt: clock().toISOString(),
        quarantineIdentity: purgedMarker,
        diagnostic: undefined,
      },
      options,
    );
  } finally {
    await writableHandle?.close().catch(() => undefined);
    await payloadHandle.close();
  }
  return { entry, reclaimedBytes: entry.target.measuredBytes };
}
