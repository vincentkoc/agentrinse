import type { Dirent, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AuditContext, CollectionResult } from "../contracts/adapter.js";
import { sha256 } from "../core/digest.js";
import { inspectProviderFile } from "../core/provider-file-identity.js";
import {
  resolveProviderFileOwnerRoot,
  type ProviderFileOwnerRootOptions,
} from "../core/provider-file-policy.js";
import { providerFilePolicy, type ProviderRules } from "../config/rule-options.js";
import { fileRules, matchesRulePath, type ProviderFileRule } from "../rules/file-rule.js";

type Directory = AsyncIterable<Dirent<string>> & { close(): Promise<void> };
type Dependencies = {
  inspect?: (path: string) => Promise<Stats>;
  openDirectory?: (path: string) => Promise<Directory>;
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function closeDirectory(directory: Directory): Promise<void> {
  try {
    await directory.close();
  } catch (error) {
    if (!hasCode(error, "ERR_DIR_CLOSED")) throw error;
  }
}

async function readNames(
  path: string,
  limit: number,
  open: (path: string) => Promise<Directory>,
  signal?: AbortSignal,
) {
  const directory = await open(path);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (names.length === limit) return undefined;
      names.push(entry.name);
    }
  } finally {
    await closeDirectory(directory);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

export async function collectProviderFileRule(
  context: AuditContext,
  ownerRoot: string,
  rule: ProviderFileRule,
  maxEntries: number,
  dependencies: Dependencies = {},
  minAgeMinutes = rule.minAgeDays * 1440,
): Promise<CollectionResult> {
  const result: CollectionResult = { resources: [], diagnostics: [] };
  const discovery = rule.discovery;
  if (discovery.kind === "native") return result;
  const inspect = dependencies.inspect ?? lstat;
  function warn(code: string, error: unknown) {
    result.diagnostics.push({
      severity: "warning",
      adapter: rule.provider,
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  let directory = ownerRoot;
  let names: string[];
  try {
    // Check each literal directory before enumerating or inspecting its children.
    for (const component of [".", ...rule.directory]) {
      directory = join(directory, component);
      const stats = await inspect(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        if (discovery.kind === "exact" && discovery.rootUnsafe)
          warn(discovery.rootUnsafe, discovery.rootUnsafeMessage);
        return result;
      }
    }
    if (discovery.kind === "exact" && "name" in rule.match) {
      names = [rule.match.name];
    } else if (discovery.kind === "children") {
      const entries = await readNames(
        directory,
        maxEntries,
        dependencies.openDirectory ?? opendir,
        context.signal,
      );
      if (!entries) {
        warn(
          discovery.truncated,
          discovery.limitLabel + " requires at most " + maxEntries + " direct entries",
        );
        return result;
      }
      names = entries;
    } else {
      throw new Error("Exact discovery requires a literal filename");
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT"))
      warn(
        discovery.kind === "children"
          ? discovery.enumerationFailed
          : (discovery.rootInspectionFailed ?? discovery.inspectionFailed),
        error,
      );
    return result;
  }

  for (const name of names) {
    context.signal?.throwIfAborted();
    if (!matchesRulePath(rule, join(...rule.directory, name))) continue;
    const path = join(directory, name);
    try {
      const stats = await inspect(path);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        context.now.getTime() - stats.mtimeMs < rule.minAgeDays * 86_400_000
      )
        continue;
      const identity = await inspectProviderFile(
        path,
        ownerRoot,
        rule.provider,
        rule.contentPrefix,
      );
      const canonicalKey = rule.id.replace(".", ":") + ":" + identity.path;
      result.resources.push({
        resource: {
          id: rule.provider + ":" + rule.resourceKind + ":" + sha256(canonicalKey),
          adapter: rule.provider,
          kind: rule.resourceKind,
          canonicalKey,
          displayName: discovery.includeBasename
            ? rule.displayName + " " + basename(identity.path)
            : rule.displayName,
          path: identity.path,
        },
        observedAt: context.now.toISOString(),
        exists: true,
        measuredBytes: identity.measuredBytes,
        facts: {
          reportOnly: false,
          maintenanceAction: "provider.file-quarantine",
          policyId: rule.id,
          minAgeMinutes,
          providerFileIdentity: identity,
        },
      });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) warn(discovery.inspectionFailed, error);
    }
  }
  return result;
}

export async function collectProviderFiles(
  provider: string,
  context: AuditContext,
  options: ProviderFileOwnerRootOptions & { maxEntries: number; providerRules?: ProviderRules },
  providerRoot?: string,
): Promise<CollectionResult> {
  const result: CollectionResult = { resources: [], diagnostics: [] };
  for (const rule of fileRules) {
    if (
      rule.provider !== provider ||
      rule.discovery.kind === "native" ||
      (!providerRoot && rule.ownerRoot === "provider-root")
    )
      continue;
    const root =
      rule.ownerRoot === "provider-root" && providerRoot
        ? providerRoot
        : resolveProviderFileOwnerRoot(rule, context.home, options);
    const policy = providerFilePolicy(rule, options.providerRules);
    const found = await collectProviderFileRule(
      context,
      root,
      rule,
      options.maxEntries,
      undefined,
      policy.minAgeMinutes,
    );
    result.resources.push(...found.resources);
    result.diagnostics.push(...found.diagnostics);
  }
  return result;
}
