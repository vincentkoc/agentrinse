import { join, resolve } from "node:path";
import type { BigIntStats } from "node:fs";
import {
  directStorageEntries,
  fileTotals,
  observeStoragePath,
  sameFileObservation,
  type Coverage,
  type EntryBudget,
} from "../../core/storage-observation.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";

export function packFileKind(name: string) {
  if (/^tmp_pack_[a-zA-Z0-9]+$/u.test(name)) return "temporary-pack-name";
  if (/^tmp_idx_[a-zA-Z0-9]+$/u.test(name)) return "temporary-index-name";
  if (name.startsWith("tmp")) return "other-temporary-name";
  const match =
    /^pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(pack|idx|rev|bitmap|mtimes|keep|promisor)$/u.exec(name);
  if (match?.[1] === "pack") return "pack";
  if (match?.[1] === "idx" || match?.[1] === "rev" || name === "multi-pack-index") return "index";
  return match ? "pack-sidecar" : "other";
}
type Kind = ReturnType<typeof packFileKind> | "ambiguous-identity";
export async function collectPackStorage(
  repos: string[],
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  list = directStorageEntries,
) {
  const stores = new Map<string, string>();
  const files = new Map<string, { kind: Kind; stats: BigIntStats; changed?: boolean }>();
  const groups = new Map<Kind, BigIntStats[]>();
  const repositories: {
    path: string;
    commonDirectory?: string;
    coverage: Coverage | "duplicate-store" | "requires-durable-owner";
    excluded?: number;
    directories?: number;
    observedByKind?: Record<string, ReturnType<typeof fileTotals>>;
  }[] = [];
  let repeatedFiles = 0,
    ambiguousFiles = 0;
  for (const repo of [...new Set(repos.map((path) => resolve(path)))].sort()) {
    if (!mounts || coveringMount(repo, mounts) !== coveringMount(join(repo, ".git"), mounts)) {
      repositories.push({ path: repo, coverage: mounts ? "mount-boundary" : "unavailable" });
      continue;
    }
    const marker = await observeStoragePath(join(repo, ".git"), mounts);
    let common = join(repo, ".git");
    if (marker.status === "missing") common = repo;
    else if (!marker.stats?.isDirectory()) {
      repositories.push({
        path: repo,
        coverage: marker.stats ? "requires-durable-owner" : marker.status,
      });
      continue;
    }
    if (
      !mounts ||
      coveringMount(repo, mounts) !== coveringMount(join(common, "objects/pack"), mounts)
    ) {
      repositories.push({ path: repo, coverage: "mount-boundary" });
      continue;
    }
    const [owner, head, objects, pointer] = await Promise.all(
      [common, join(common, "HEAD"), join(common, "objects"), join(common, "commondir")].map((p) =>
        observeStoragePath(p, mounts),
      ),
    );
    if (
      !owner?.stats?.isDirectory() ||
      !head?.stats?.isFile() ||
      !objects?.stats?.isDirectory() ||
      pointer?.status !== "missing"
    ) {
      repositories.push({ path: repo, coverage: "requires-durable-owner" });
      continue;
    }
    const key = owner.stats.dev + ":" + owner.stats.ino;
    if (stores.has(key)) {
      repositories.push({ path: repo, commonDirectory: common, coverage: "duplicate-store" });
      continue;
    }
    stores.set(key, common);
    const path = join(common, "objects", "pack");
    const scanned = await list(path, mounts!, budget);
    const localGroups = new Map<Kind, BigIntStats[]>();
    let dirs = 0;
    for (const entry of scanned.entries) {
      if (!entry.stats.isFile()) {
        dirs++;
        continue;
      }
      const identity = entry.stats.dev + ":" + entry.stats.ino,
        kind = packFileKind(entry.name);
      const local = localGroups.get(kind) ?? [];
      local.push(entry.stats);
      localGroups.set(kind, local);
      const previous = files.get(identity);
      if (previous) {
        repeatedFiles++;
        if (!sameFileObservation(previous.stats, entry.stats)) previous.changed = true;
        if (
          previous.kind !== "ambiguous-identity" &&
          (previous.kind !== kind || previous.changed)
        ) {
          previous.kind = "ambiguous-identity";
          ambiguousFiles++;
        }
        continue;
      }
      files.set(identity, { kind, stats: entry.stats });
    }
    repositories.push({
      path: repo,
      commonDirectory: common,
      coverage: scanned.coverage,
      excluded: scanned.excluded,
      directories: dirs,
      observedByKind: Object.fromEntries(
        [...localGroups].map(([kind, stats]) => [kind, fileTotals(stats)]),
      ),
    });
  }
  const stableFiles = [...files.values()].filter((f) => !f.changed);
  for (const { kind, stats } of stableFiles) {
    const list = groups.get(kind) ?? [];
    list.push(stats);
    groups.set(kind, list);
  }
  return {
    repositories,
    commonStores: stores.size,
    repeatedFiles,
    ambiguousFiles,
    byKind: Object.fromEntries([...groups].map(([kind, stats]) => [kind, fileTotals(stats)])),
    uniqueDirectFiles: fileTotals(stableFiles.map((f) => f.stats)),
    changedFilesOmitted: files.size - stableFiles.length,
    reclaimableBytes: null,
  };
}
