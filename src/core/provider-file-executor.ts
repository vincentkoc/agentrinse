import { constants } from "node:fs";
import { lstat, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderFileQuarantineAction } from "../contracts/action.js";
import {
  providerFileQuarantineEntrySchema,
  type ProviderFileQuarantineEntry,
} from "../contracts/provider-file-quarantine.js";
import { ensurePrivateDirectory, syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import {
  inspectProviderFile,
  providerFileIdentityMatches,
  providerFileStatsMatch,
} from "./provider-file-identity.js";
import {
  revalidateProviderFileQuarantine,
  type ProviderFileRevalidationDependencies,
} from "./provider-file-revalidation.js";

export type ProviderFileExecutionOutcome =
  | "skipped-stale"
  | "failed"
  | "rolled-back"
  | "partially-applied";

export class ProviderFileExecutionError extends Error {
  override readonly name = "ProviderFileExecutionError";

  constructor(
    message: string,
    readonly outcome: ProviderFileExecutionOutcome,
    readonly diagnosticCode: string,
    readonly entry?: ProviderFileQuarantineEntry,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ProviderFileExecutorDependencies = ProviderFileRevalidationDependencies & {
  clock?: () => Date;
  move?: (source: string, destination: string) => Promise<void>;
  chmodHandle?: (handle: FileHandle, mode: number) => Promise<void>;
  authorization?: {
    expiresAtMs: number;
    now: () => Date;
  };
  platform?: NodeJS.Platform;
};

export type ExecuteProviderFileQuarantineOptions = {
  runId: string;
  entryId: string;
  quarantineDirectory: string;
  dependencies?: ProviderFileExecutorDependencies;
};

export type ProviderFileExecutionResult = {
  quarantineEntryId: string;
  quarantinePath: string;
  quarantinedBytes: number;
  manifestPath: string;
};

export function providerFileQuarantinePath(quarantineDirectory: string, entryId: string): string {
  return join(quarantineDirectory, `${entryId}.payload`);
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

async function persist(
  manifestPath: string,
  quarantineDirectory: string,
  entry: ProviderFileQuarantineEntry,
): Promise<ProviderFileQuarantineEntry> {
  const parsed = providerFileQuarantineEntrySchema.parse(entry);
  await writeJsonAtomic(manifestPath, parsed, {
    privateDirectories: [quarantineDirectory],
  });
  return parsed;
}

async function finalizeUnmovedEntry(
  entry: ProviderFileQuarantineEntry,
  manifestPath: string,
  quarantineDirectory: string,
  clock: () => Date,
): Promise<ProviderFileQuarantineEntry> {
  try {
    return await persist(manifestPath, quarantineDirectory, {
      ...entry,
      status: "restored",
      restoredAt: clock().toISOString(),
    });
  } catch (error) {
    await rm(manifestPath, { force: true }).catch(() => undefined);
    await syncDirectory(quarantineDirectory).catch(() => undefined);
    throw error;
  }
}

function assertAuthorized(
  dependencies: ProviderFileExecutorDependencies,
  entry?: ProviderFileQuarantineEntry,
): void {
  if (
    dependencies.authorization !== undefined &&
    dependencies.authorization.now().getTime() >= dependencies.authorization.expiresAtMs
  ) {
    throw new ProviderFileExecutionError(
      "cleanup plan authorization expired before provider-file quarantine",
      "skipped-stale",
      "PLAN_EXPIRED_DURING_APPLY",
      entry,
    );
  }
}

export async function executeProviderFileQuarantine(
  action: ProviderFileQuarantineAction,
  options: ExecuteProviderFileQuarantineOptions,
): Promise<ProviderFileExecutionResult> {
  const dependencies = options.dependencies ?? {};
  const clock = dependencies.clock ?? (() => new Date());
  const move =
    dependencies.move ??
    ((source: string, destination: string) =>
      renameNoReplace(source, destination, dependencies.platform ?? process.platform));
  const quarantinePath = providerFileQuarantinePath(options.quarantineDirectory, options.entryId);
  const manifestPath = join(options.quarantineDirectory, `${options.entryId}.json`);

  if (!["darwin", "linux"].includes(dependencies.platform ?? process.platform)) {
    throw new ProviderFileExecutionError(
      `provider-file quarantine is unsupported on ${dependencies.platform ?? process.platform}`,
      "skipped-stale",
      "PROVIDER_FILE_PLATFORM_UNSUPPORTED",
    );
  }
  if (dependencies.authorizeTarget === undefined) {
    throw new ProviderFileExecutionError(
      "provider-file execution requires an approved provider policy",
      "skipped-stale",
      "PROVIDER_FILE_POLICY_REFUSED",
    );
  }
  try {
    await dependencies.authorizeTarget(action);
  } catch (error) {
    throw new ProviderFileExecutionError(
      error instanceof Error ? error.message : String(error),
      "skipped-stale",
      "PROVIDER_FILE_POLICY_REFUSED",
      undefined,
      { cause: error },
    );
  }

  await ensurePrivateDirectory(options.quarantineDirectory);
  const [quarantineStats, sourceStats] = await Promise.all([
    lstat(options.quarantineDirectory),
    lstat(action.target.path),
  ]);
  if (quarantineStats.dev !== sourceStats.dev) {
    throw new ProviderFileExecutionError(
      "provider-file recovery storage is on a different filesystem",
      "skipped-stale",
      "PROVIDER_FILE_QUARANTINE_CROSS_DEVICE",
    );
  }
  if ((await pathExists(quarantinePath)) || (await pathExists(manifestPath))) {
    throw new ProviderFileExecutionError(
      "provider-file quarantine destination already exists",
      "failed",
      "PROVIDER_FILE_DESTINATION_OCCUPIED",
    );
  }

  let entry = await persist(manifestPath, options.quarantineDirectory, {
    schemaVersion: 1,
    entryId: options.entryId,
    runId: options.runId,
    actionId: action.actionId,
    resourceId: action.resourceId,
    policyId: action.policyId,
    status: "preparing",
    originalPath: action.target.path,
    quarantinePath,
    createdAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + action.quarantineTtlMinutes * 60_000).toISOString(),
    target: action.target,
  });

  let moved = false;
  let modeSealed = false;
  let sourceHandle: FileHandle | undefined;
  const originalMode = action.target.mode & 0o7777;
  const chmodHandle =
    dependencies.chmodHandle ?? ((handle: FileHandle, mode: number) => handle.chmod(mode));
  try {
    sourceHandle = await open(action.target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!providerFileStatsMatch(await sourceHandle.stat(), action.target)) {
      throw new ProviderFileExecutionError(
        "provider file identity changed while acquiring exclusive access",
        "skipped-stale",
        "PROVIDER_FILE_IDENTITY_CHANGED",
        entry,
      );
    }
    await chmodHandle(sourceHandle, originalMode & ~0o222);
    modeSealed = true;
    await sourceHandle.sync();
    if (!providerFileStatsMatch(await sourceHandle.stat(), action.target, true)) {
      throw new ProviderFileExecutionError(
        "provider file identity changed while sealing exclusive access",
        "skipped-stale",
        "PROVIDER_FILE_IDENTITY_CHANGED",
        entry,
      );
    }
    const sealed = await inspectProviderFile(
      action.target.path,
      action.target.ownerRoot,
      action.target.provider,
    );
    if (!providerFileIdentityMatches(sealed, action.target, true)) {
      throw new ProviderFileExecutionError(
        "provider file identity changed while acquiring exclusive access",
        "skipped-stale",
        "PROVIDER_FILE_IDENTITY_CHANGED",
        entry,
      );
    }
    const readiness = await revalidateProviderFileQuarantine(
      {
        ...action,
        target: sealed,
      },
      undefined,
      undefined,
      {
        ...dependencies,
        allowedHandlePids: new Set([...(dependencies.allowedHandlePids ?? []), process.pid]),
      },
    );
    if (readiness.status === "stale") {
      throw new ProviderFileExecutionError(
        readiness.diagnostic.message,
        "skipped-stale",
        readiness.diagnostic.code,
        entry,
      );
    }
    assertAuthorized(dependencies, entry);
    await move(action.target.path, quarantinePath);
    moved = true;
    if (!providerFileStatsMatch(await lstat(quarantinePath), action.target, true)) {
      let rollbackError: unknown;
      try {
        await move(quarantinePath, action.target.path);
        await Promise.all([
          syncDirectory(dirname(action.target.path)),
          syncDirectory(options.quarantineDirectory),
        ]);
        moved = false;
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError !== undefined) {
        throw new ProviderFileExecutionError(
          "an unexpected inode was moved and rollback failed",
          "partially-applied",
          "PROVIDER_FILE_UNEXPECTED_INODE_PARTIAL",
          entry,
          { cause: rollbackError },
        );
      }
      throw new ProviderFileExecutionError(
        "source pathname changed before the atomic move; the unexpected inode was restored",
        "rolled-back",
        "PROVIDER_FILE_UNEXPECTED_INODE_ROLLED_BACK",
        entry,
      );
    }
    await Promise.all([
      syncDirectory(dirname(action.target.path)),
      syncDirectory(options.quarantineDirectory),
    ]);
    await chmodHandle(sourceHandle, originalMode);
    modeSealed = false;
    await sourceHandle.sync();
    const quarantineIdentity = await inspectProviderFile(
      quarantinePath,
      options.quarantineDirectory,
      action.target.provider,
    );
    if (
      quarantineIdentity.device !== action.target.device ||
      quarantineIdentity.inode !== action.target.inode ||
      quarantineIdentity.mode !== action.target.mode ||
      quarantineIdentity.mtimeMs !== action.target.mtimeMs ||
      quarantineIdentity.measuredBytes !== action.target.measuredBytes ||
      quarantineIdentity.contentSha256 !== action.target.contentSha256
    ) {
      throw new ProviderFileExecutionError(
        "quarantined provider file no longer matches the planned content identity",
        "partially-applied",
        "PROVIDER_FILE_QUARANTINE_IDENTITY_CHANGED",
        entry,
      );
    }
    entry = await persist(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "quarantined",
      quarantineIdentity,
    });
    return {
      quarantineEntryId: entry.entryId,
      quarantinePath: entry.quarantinePath,
      quarantinedBytes: entry.target.measuredBytes,
      manifestPath,
    };
  } catch (error) {
    if (!moved) {
      if (modeSealed && sourceHandle !== undefined) {
        try {
          await chmodHandle(sourceHandle, originalMode);
          await sourceHandle.sync();
          modeSealed = false;
        } catch (restoreError) {
          throw new ProviderFileExecutionError(
            "provider file permissions could not be restored; recovery remains pending",
            "partially-applied",
            "PROVIDER_FILE_PERMISSION_RESTORE_FAILED",
            entry,
            { cause: new AggregateError([error, restoreError]) },
          );
        }
      }
      entry = await finalizeUnmovedEntry(entry, manifestPath, options.quarantineDirectory, clock);
      if (error instanceof ProviderFileExecutionError) {
        throw error;
      }
      throw new ProviderFileExecutionError(
        error instanceof Error ? error.message : String(error),
        "failed",
        "PROVIDER_FILE_QUARANTINE_FAILED",
        entry,
        { cause: error },
      );
    }

    const quarantineIdentity = await inspectProviderFile(
      quarantinePath,
      options.quarantineDirectory,
      action.target.provider,
    ).catch(() => undefined);
    if (quarantineIdentity !== undefined) {
      entry = await persist(manifestPath, options.quarantineDirectory, {
        ...entry,
        status: "partial",
        quarantineIdentity,
        diagnostic: {
          severity: "error",
          code: "PROVIDER_FILE_QUARANTINE_PARTIAL",
          message: error instanceof Error ? error.message : String(error),
          adapter: action.adapter,
          resourceId: action.resourceId,
        },
      }).catch(() => entry);
    }
    throw new ProviderFileExecutionError(
      error instanceof Error ? error.message : String(error),
      "partially-applied",
      "PROVIDER_FILE_QUARANTINE_PARTIAL",
      entry,
      { cause: error },
    );
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }
}
