import { chmod, lstat, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  providerFileQuarantineEntrySchema,
  type ProviderFileQuarantineEntry,
} from "../contracts/provider-file-quarantine.js";
import { syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { inspectProviderFile, providerFileIdentityMatches } from "./provider-file-identity.js";
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
  platform?: NodeJS.Platform;
};

export type ProviderFileRecoveryOptions = {
  manifestPath: string;
  quarantineDirectory: string;
  allowUnexpired?: boolean;
  dependencies?: ProviderFileRecoveryDependencies;
};

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
    (actual.mode === expected.mode || actual.mode === (expected.mode & ~0o222)) &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.measuredBytes === expected.measuredBytes &&
    actual.contentSha256 === expected.contentSha256
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
  if (!(await pathExists(entry.quarantinePath))) {
    return undefined;
  }
  return inspectProviderFile(
    entry.quarantinePath,
    options.quarantineDirectory,
    entry.target.provider,
  );
}

async function reconcile(
  entry: ProviderFileQuarantineEntry,
  options: ProviderFileRecoveryOptions,
): Promise<ProviderFileQuarantineEntry> {
  assertOwnedPaths(entry, options);
  const [original, quarantine] = await Promise.all([
    inspectOriginal(entry),
    inspectQuarantine(entry, options),
  ]);
  if (original !== undefined && quarantine !== undefined) {
    throw new Error("provider-file recovery state is ambiguous: both paths are occupied");
  }
  if (original === undefined && quarantine === undefined) {
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
    await chmod(entry.originalPath, entry.target.mode & 0o7777);
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
  if (quarantine === undefined || !movedIdentityMatches(quarantine, entry)) {
    throw new Error("provider-file quarantine payload no longer matches the recovery manifest");
  }
  if (["preparing", "quarantined", "restoring", "partial"].includes(entry.status)) {
    return persist(
      {
        ...entry,
        status: entry.status === "restoring" ? "restoring" : "quarantined",
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
  if (!["quarantined", "restoring", "partial"].includes(entry.status)) {
    throw new Error(`provider-file quarantine entry cannot be restored from ${entry.status}`);
  }
  await assertOffline(entry, entry.quarantinePath, dependencies);
  entry = await persist({ ...entry, status: "restoring" }, options);
  await move(entry.quarantinePath, entry.originalPath);
  await chmod(entry.originalPath, entry.target.mode & 0o7777);
  await Promise.all([
    syncDirectory(dirname(entry.originalPath)),
    syncDirectory(options.quarantineDirectory),
  ]);
  const restored = await inspectProviderFile(
    entry.originalPath,
    entry.target.ownerRoot,
    entry.target.provider,
  );
  if (!providerFileIdentityMatches(restored, entry.target)) {
    throw new Error("restored provider file no longer matches the recovery manifest");
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
  let entry = await reconcile(providerFileQuarantineEntrySchema.parse(input), options);
  if (entry.status === "purged") {
    return { entry, reclaimedBytes: 0 };
  }
  if (!["quarantined", "purging"].includes(entry.status)) {
    throw new Error(`provider-file quarantine entry cannot be purged from ${entry.status}`);
  }
  if (!options.allowUnexpired && Date.parse(entry.expiresAt) > clock().getTime()) {
    throw new Error(`provider-file quarantine entry has not expired: ${entry.entryId}`);
  }
  await assertOffline(entry, entry.quarantinePath, dependencies);
  entry = await persist({ ...entry, status: "purging" }, options);
  await rm(entry.quarantinePath);
  await syncDirectory(options.quarantineDirectory);
  entry = await persist(
    {
      ...entry,
      status: "purged",
      purgedAt: clock().toISOString(),
      diagnostic: undefined,
    },
    options,
  );
  return { entry, reclaimedBytes: entry.target.measuredBytes };
}
