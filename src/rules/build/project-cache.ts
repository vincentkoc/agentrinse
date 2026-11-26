import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import type { AuditContext } from "../../contracts/adapter.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import type { MountBoundaryResult } from "../../core/mount-boundaries.js";
import { readProjectFile } from "../../core/project-file.js";
import { isPathInside } from "../../core/safety.js";
import { jitiProjectCache } from "../jiti/project-cache.js";
import { viteProjectCaches } from "../vite/project-cache.js";

const rules = [...viteProjectCaches, jitiProjectCache];
const manifestLimit = 256 * 1024;

function declares(group: unknown, dependency: string): boolean {
  return (
    typeof group === "object" &&
    group !== null &&
    Object.hasOwn(group, dependency) &&
    typeof (group as Record<string, unknown>)[dependency] === "string"
  );
}

async function cacheDirectory(root: string, parts: readonly string[], device: number) {
  let path = root;
  let stats: Stats | undefined;
  try {
    for (const part of parts) {
      path = join(path, part);
      stats = await lstat(path);
      if (!stats.isDirectory() || stats.dev !== device || (await realpath(path)) !== path) return;
    }
    if (stats) return { path, inode: stats.ino };
  } catch {
    // An absent or inaccessible directory has no finding.
  }
}

export async function collectProjectCaches(
  context: AuditContext,
  project: string,
  mountProbe: (path: string) => Promise<MountBoundaryResult>,
): Promise<ResourceSnapshot[]> {
  const resources: ResourceSnapshot[] = [];
  try {
    const home = await lstat(context.home);
    if (!home.isDirectory() || (await realpath(context.home)) !== context.home) return [];
    const modules = join(project, "node_modules");
    for (const path of [project, modules]) {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.dev !== home.dev || (await realpath(path)) !== path)
        return [];
    }
    const candidates = [];
    for (const rule of rules) {
      // Probe only immediate children before consulting the mount table.
      const prefix = await cacheDirectory(modules, [rule.components[0]], home.dev);
      if (prefix) candidates.push({ rule, prefix });
    }
    if (!candidates.length) return [];
    const manifest = join(project, "package.json");
    const mounts = await mountProbe(context.home);
    if (mounts.status === "unknown") return [];
    const mounted = (path: string) =>
      mounts.paths.some((mount) => mount !== context.home && isPathInside(mount, path));
    if (mounted(manifest)) return [];
    const local = [];
    for (const { rule, prefix } of candidates) {
      const path = join(modules, ...rule.components);
      if (mounted(path)) continue;
      const cache =
        rule.components.length === 1
          ? prefix
          : await cacheDirectory(project, ["node_modules", ...rule.components], home.dev);
      if (cache) local.push({ rule, ...cache });
    }
    if (!local.length) return [];
    const bytes = await readProjectFile(manifest, home.dev, { maxBytes: manifestLimit });
    if (!bytes) return [];
    const pkg: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof pkg !== "object" || pkg === null) return [];
    for (const { rule, path, inode } of local) {
      if (
        !declares("dependencies" in pkg && pkg.dependencies, rule.dependency) &&
        !declares("devDependencies" in pkg && pkg.devDependencies, rule.dependency)
      )
        continue;
      const current = await cacheDirectory(project, ["node_modules", ...rule.components], home.dev);
      if (!current || current.inode !== inode) continue;
      const canonicalKey = "artifacts:" + rule.id + ":" + path;
      resources.push({
        resource: {
          id: "artifacts:" + rule.dependency + ":" + sha256(canonicalKey),
          adapter: "artifacts",
          kind: "agent-cache",
          displayName: rule.displayName,
          canonicalKey,
          path,
        },
        exists: true,
        observedAt: context.now.toISOString(),
        facts: { ruleId: rule.id, projectRoot: project },
      });
    }
  } catch {
    // Unverified project metadata cannot establish cache ownership.
  }
  return resources;
}

export function classifyProjectCache(context: AuditContext, resource: ResourceSnapshot) {
  const rule = rules.find((candidate) => resource.facts.ruleId === candidate.id);
  if (!rule || resource.resource.kind !== "agent-cache") return undefined;
  return reportOnlyFinding(
    context,
    resource,
    "artifacts",
    "high",
    [{ code: rule.reason, detail: rule.detail }],
    { estimatedReclaimBytes: 0 },
  );
}
