import { chmod, lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProviderFileQuarantineAction } from "../contracts/action.js";
import {
  providerFileQuarantineEntrySchema,
  type ProviderFileQuarantineEntry,
} from "../contracts/provider-file-quarantine.js";
import { ensurePrivateDirectory, syncDirectory, writeJsonAtomic } from "../state/json-file.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { inspectProviderFile, providerFileIdentityMatches } from "./provider-file-identity.js";
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

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
    status: "preparing",
    originalPath: action.target.path,
    quarantinePath,
    createdAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + action.quarantineTtlMinutes * 60_000).toISOString(),
    target: action.target,
  });

  let moved = false;
  const originalMode = action.target.mode & 0o7777;
  try {
    await chmod(action.target.path, originalMode & ~0o222);
    await syncFile(action.target.path);
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
      dependencies,
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
    await Promise.all([
      syncDirectory(dirname(action.target.path)),
      syncDirectory(options.quarantineDirectory),
    ]);
    await chmod(quarantinePath, originalMode);
    await syncFile(quarantinePath);
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
      await chmod(action.target.path, originalMode).catch(() => undefined);
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
  }
}
