import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import type { AuditContext } from "../../contracts/adapter.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import type { MountBoundaryResult } from "../../core/mount-boundaries.js";
import { readProjectFile } from "../../core/project-file.js";
import { isPathInside } from "../../core/safety.js";

const ruleId = "vite.project-cache";
const manifestLimit = 256 * 1024;

function declaresVite(group: unknown): boolean {
  return (
    typeof group === "object" &&
    group !== null &&
    Object.hasOwn(group, "vite") &&
    typeof (group as Record<string, unknown>).vite === "string"
  );
}

export async function collectViteProjectCache(
  context: AuditContext,
  project: string,
  mountProbe: (path: string) => Promise<MountBoundaryResult>,
): Promise<ResourceSnapshot | undefined> {
  const modules = join(project, "node_modules");
  const path = join(modules, ".vite");
  const manifest = join(project, "package.json");
  try {
    const home = await lstat(context.home);
    if (!home.isDirectory() || (await realpath(context.home)) !== context.home) return;
    const homeDevice = home.dev;
    // The configured project was already validated. Check each direct child before inspecting its child.
    const projectStats = await lstat(project);
    if (
      !projectStats.isDirectory() ||
      projectStats.dev !== homeDevice ||
      (await realpath(project)) !== project
    )
      return;
    const parent = await lstat(modules);
    if (!parent.isDirectory() || parent.dev !== homeDevice) return;
    const cache = await lstat(path);
    if (!cache.isDirectory() || cache.dev !== homeDevice) return;
    const metadata = await lstat(manifest);
    if (!metadata.isFile() || metadata.dev !== homeDevice || metadata.size > manifestLimit) return;
    const mounts = await mountProbe(context.home);
    if (
      mounts.status === "unknown" ||
      mounts.paths.some(
        (mount) =>
          mount !== context.home && (isPathInside(mount, path) || isPathInside(mount, manifest)),
      )
    )
      return;
    const bytes = await readProjectFile(manifest, homeDevice, { maxBytes: manifestLimit });
    if (!bytes) return;
    const pkg: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof pkg !== "object" || pkg === null) return;
    if (
      !declaresVite("dependencies" in pkg && pkg.dependencies) &&
      !declaresVite("devDependencies" in pkg && pkg.devDependencies)
    )
      return;
    const current = await lstat(path);
    if ((await realpath(path)) !== path || current.dev !== cache.dev || current.ino !== cache.ino)
      return;
    const canonicalKey = "artifacts:" + ruleId + ":" + path;
    return {
      resource: {
        id: "artifacts:vite:" + sha256(canonicalKey),
        adapter: "artifacts",
        kind: "agent-cache",
        displayName: "Vite project cache",
        canonicalKey,
        path,
      },
      exists: true,
      observedAt: context.now.toISOString(),
      facts: { ruleId, projectRoot: project },
    };
  } catch {
    return undefined;
  }
}

export function classifyViteProjectCache(context: AuditContext, resource: ResourceSnapshot) {
  if (resource.facts.ruleId !== ruleId || resource.resource.kind !== "agent-cache")
    return undefined;
  return reportOnlyFinding(
    context,
    resource,
    "artifacts",
    "high",
    [
      {
        code: "vite-project-cache",
        detail: "Configured project declares Vite and contains its default cache directory.",
      },
    ],
    { estimatedReclaimBytes: 0 },
  );
}
