import type { Dirent, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
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

type DebugDirectory = {
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterableIterator<Dirent<string>>;
};

export type ClaudeDebugDependencies = {
  inspect?: (path: string) => Promise<Stats>;
  openDirectory?: (path: string) => Promise<DebugDirectory>;
};

async function closeDirectory(directory: DebugDirectory): Promise<void> {
  try {
    await directory.close();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ERR_DIR_CLOSED")) {
      throw error;
    }
  }
}

export async function collectClaudeDebugLogs(
  context: AuditContext,
  ownerRoot: string,
  maxEntries: number,
  dependencies: ClaudeDebugDependencies = {},
): Promise<CollectionResult> {
  const debugRoot = join(ownerRoot, "debug");
  const diagnostics: CollectionResult["diagnostics"] = [];
  const inspect = dependencies.inspect ?? lstat;
  const openDirectory = dependencies.openDirectory ?? opendir;
  const entries: Dirent<string>[] = [];
  let truncated = false;

  try {
    const rootStats = await inspect(debugRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return { resources: [], diagnostics };
    }
    const directory = await openDirectory(debugRoot);
    try {
      for await (const entry of directory) {
        context.signal?.throwIfAborted();
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
    } finally {
      await closeDirectory(directory);
    }
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

  if (truncated) {
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
      const stats = await inspect(path);
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
