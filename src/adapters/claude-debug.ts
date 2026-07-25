import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AuditContext, CollectionResult } from "../contracts/adapter.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { sha256 } from "../core/digest.js";
import { inspectProviderFile } from "../core/provider-file-identity.js";
import {
  CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES,
  CLAUDE_DEBUG_LOG_POLICY_ID,
  isClaudeDebugLogRelativePath,
} from "../core/provider-file-policy.js";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function collectClaudeDebugLogs(
  context: AuditContext,
  ownerRoot: string,
  maxEntries: number,
): Promise<CollectionResult> {
  const debugRoot = join(ownerRoot, "debug");
  const diagnostics: CollectionResult["diagnostics"] = [];
  let entries: Dirent<string>[];

  try {
    const rootStats = await lstat(debugRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return { resources: [], diagnostics };
    }
    entries = await readdir(debugRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return { resources: [], diagnostics };
    }
    return {
      resources: [],
      diagnostics: [
        {
          severity: "warning",
          code: "CLAUDE_DEBUG_ENUMERATION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: "claude",
        },
      ],
    };
  }

  if (entries.length > maxEntries) {
    return {
      resources: [],
      diagnostics: [
        {
          severity: "warning",
          code: "CLAUDE_DEBUG_ENUMERATION_TRUNCATED",
          message: `Claude debug cleanup requires at most ${maxEntries} direct entries`,
          adapter: "claude",
        },
      ],
    };
  }

  const cutoffMs = context.now.getTime() - CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES * 60_000;
  const resources: ResourceSnapshot[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    context.signal?.throwIfAborted();
    const path = join(debugRoot, entry.name);
    const relativePath = join("debug", entry.name);
    if (!isClaudeDebugLogRelativePath(relativePath)) {
      continue;
    }

    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs > cutoffMs) {
        continue;
      }
      const identity = await inspectProviderFile(path, ownerRoot, "claude");
      const canonicalKey = `claude:debug-log:${identity.path}`;
      resources.push({
        resource: {
          id: `claude:agent-log-store:${sha256(canonicalKey)}`,
          adapter: "claude",
          kind: "agent-log-store",
          canonicalKey,
          displayName: `Claude debug log ${basename(identity.path)}`,
          path: identity.path,
        },
        observedAt: context.now.toISOString(),
        exists: true,
        measuredBytes: identity.measuredBytes,
        facts: {
          reportOnly: false,
          maintenanceAction: "provider.file-quarantine",
          policyId: CLAUDE_DEBUG_LOG_POLICY_ID,
          minAgeMinutes: CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES,
          providerFileIdentity: identity,
        },
      });
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      diagnostics.push({
        severity: "warning",
        code: "CLAUDE_DEBUG_FILE_INSPECTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        adapter: "claude",
      });
    }
  }

  return { resources, diagnostics };
}
