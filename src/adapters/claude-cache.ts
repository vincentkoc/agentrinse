import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { AuditContext, CollectionResult } from "../contracts/adapter.js";
import { sha256 } from "../core/digest.js";
import { inspectProviderFile } from "../core/provider-file-identity.js";
import {
  CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES,
  CLAUDE_CHANGELOG_CACHE_POLICY_ID,
} from "../core/provider-file-policy.js";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function collectClaudeChangelogCache(
  context: AuditContext,
  ownerRoot: string,
): Promise<CollectionResult> {
  const cacheRoot = join(ownerRoot, "cache");
  const path = join(cacheRoot, "changelog.md");

  try {
    const cacheStats = await lstat(cacheRoot);
    if (cacheStats.isSymbolicLink() || !cacheStats.isDirectory()) {
      return { resources: [], diagnostics: [] };
    }

    const stats = await lstat(path);
    const cutoffMs = context.now.getTime() - CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES * 60_000;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs > cutoffMs) {
      return { resources: [], diagnostics: [] };
    }

    const identity = await inspectProviderFile(path, ownerRoot, "claude");
    const canonicalKey = `claude:changelog-cache:${identity.path}`;
    return {
      resources: [
        {
          resource: {
            id: `claude:agent-cache:${sha256(canonicalKey)}`,
            adapter: "claude",
            kind: "agent-cache",
            canonicalKey,
            displayName: "Claude changelog cache",
            path: identity.path,
          },
          observedAt: context.now.toISOString(),
          exists: true,
          measuredBytes: identity.measuredBytes,
          facts: {
            reportOnly: false,
            maintenanceAction: "provider.file-quarantine",
            policyId: CLAUDE_CHANGELOG_CACHE_POLICY_ID,
            minAgeMinutes: CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES,
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
          code: "CLAUDE_CHANGELOG_CACHE_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: "claude",
        },
      ],
    };
  }
}
