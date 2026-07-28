import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AuditContext, CollectionResult } from "../contracts/adapter.js";
import { sha256 } from "../core/digest.js";
import { inspectProviderFile } from "../core/provider-file-identity.js";
import {
  PROVIDER_FILE_POLICIES,
  resolveProviderFileOwnerRoot,
  type ProviderFilePolicy,
  ZED_ROTATED_LOG_MIN_AGE_MINUTES,
  ZED_ROTATED_LOG_POLICY_ID,
} from "../core/provider-file-policy.js";

export type ZedLogOptions = {
  root?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
};

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function zedRotatedLogPolicy(): ProviderFilePolicy {
  const policy = PROVIDER_FILE_POLICIES.find(
    (candidate) => candidate.id === ZED_ROTATED_LOG_POLICY_ID && candidate.provider === "zed",
  );
  if (policy === undefined) {
    throw new Error("Zed rotated-log policy is not registered");
  }
  return policy;
}

const ZED_ROTATED_LOG_POLICY = zedRotatedLogPolicy();

export async function collectZedRotatedLog(
  context: AuditContext,
  options: ZedLogOptions = {},
): Promise<CollectionResult> {
  const ownerRoot = resolveProviderFileOwnerRoot(ZED_ROTATED_LOG_POLICY, context.home, options);
  try {
    const rootStats = await lstat(ownerRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return {
        resources: [],
        diagnostics: [
          {
            severity: "warning",
            code: "ZED_LOG_ROOT_UNSAFE",
            message: "Zed log cleanup requires a direct non-symlink directory.",
            adapter: "zed",
          },
        ],
      };
    }
  } catch (error) {
    if (isMissing(error)) {
      return { resources: [], diagnostics: [] };
    }
    return {
      resources: [],
      diagnostics: [
        {
          severity: "warning",
          code: "ZED_LOG_ROOT_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: "zed",
        },
      ],
    };
  }

  const path = join(ownerRoot, "Zed.log.old");
  try {
    const stats = await lstat(path);
    const cutoffMs = context.now.getTime() - ZED_ROTATED_LOG_MIN_AGE_MINUTES * 60_000;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs > cutoffMs) {
      return { resources: [], diagnostics: [] };
    }
    const identity = await inspectProviderFile(path, ownerRoot, "zed");
    const canonicalKey = `zed:rotated-log:${identity.path}`;
    return {
      resources: [
        {
          resource: {
            id: `zed:agent-log-store:${sha256(canonicalKey)}`,
            adapter: "zed",
            kind: ZED_ROTATED_LOG_POLICY.resourceKind,
            canonicalKey,
            displayName: `${ZED_ROTATED_LOG_POLICY.displayName} ${basename(identity.path)}`,
            path: identity.path,
          },
          observedAt: context.now.toISOString(),
          exists: true,
          measuredBytes: identity.measuredBytes,
          facts: {
            reportOnly: false,
            maintenanceAction: "provider.file-quarantine",
            policyId: ZED_ROTATED_LOG_POLICY_ID,
            minAgeMinutes: ZED_ROTATED_LOG_MIN_AGE_MINUTES,
            providerFileIdentity: identity,
          },
        },
      ],
      diagnostics: [],
    };
  } catch (error) {
    if (isMissing(error)) {
      return { resources: [], diagnostics: [] };
    }
    return {
      resources: [],
      diagnostics: [
        {
          severity: "warning",
          code: "ZED_ROTATED_LOG_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: "zed",
        },
      ],
    };
  }
}
