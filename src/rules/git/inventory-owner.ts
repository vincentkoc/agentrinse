import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import { readProjectFile } from "../../core/project-file.js";
import { coveringMount, sameStorageMount, type StorageMount } from "../../core/storage-mounts.js";
import {
  observeStoragePath,
  sameDirectoryBinding,
  sameObservation,
} from "../../core/storage-observation.js";

export type InventoryOwner = {
  path: string;
  common: string;
  ownerStats: BigIntStats;
  commonStats: BigIntStats;
};

export async function discoverOwner(path: string, mounts: StorageMount[] | undefined) {
  const base = await observeStoragePath(path, mounts);
  if (!base.stats?.isDirectory()) return { coverage: base.stats ? "unexpected-kind" : base.status };
  const markerPath = join(path, ".git"),
    m = coveringMount(path, mounts!);
  if (m !== coveringMount(markerPath, mounts!)) return { coverage: "mount-boundary" };
  const marker = await observeStoragePath(markerPath, mounts);
  if (marker.status !== "missing" && !marker.stats?.isDirectory())
    return { coverage: marker.stats ? "requires-durable-owner" : marker.status };
  const common = marker.status === "missing" ? path : markerPath,
    commonStats = marker.stats ?? base.stats;
  for (const name of ["HEAD", "objects", "refs", "config", "commondir"]) {
    const child = join(common, name);
    if (m !== coveringMount(child, mounts!)) return { coverage: "mount-boundary" };
    const seen = await observeStoragePath(child, mounts);
    if (name === "commondir" && seen.status === "missing") continue;
    if (name === "HEAD" && marker.status === "missing" && seen.status === "missing")
      return { coverage: "not-owner" };
    if (
      name === "commondir" ||
      (["objects", "refs"].includes(name) ? !seen.stats?.isDirectory() : !seen.stats?.isFile())
    )
      return { coverage: "unverified-owner" };
  }
  const head = await readProjectFile(join(common, "HEAD"), Number(commonStats.dev), {
    maxBytes: 16384,
  });
  if (
    !head ||
    !/^(?:ref: refs\/[^\s\p{Cc}]+|[a-f\d]{40}|[a-f\d]{64})\r?\n?$/u.test(head.toString("utf8"))
  )
    return { coverage: "unverified-owner" };
  return { coverage: "owner", owner: { path, common, ownerStats: base.stats, commonStats } };
}
function sameMount(path: string, before: StorageMount[], after: StorageMount[]) {
  const first = coveringMount(path, before);
  const last = coveringMount(path, after);
  return first?.access === "local" && last?.access === "local" && sameStorageMount(first, last);
}

// A changed common directory needs a fresh owner proof. Its entry timestamps alone cannot
// invalidate sibling scans: ordinary index and FETCH_HEAD replacement changes them as well.
export async function recheckOwner(
  owner: InventoryOwner,
  original: StorageMount[],
  readMounts: () => Promise<StorageMount[] | undefined>,
) {
  const current = await observeStoragePath(owner.common, original);
  if (!current.stats || !sameDirectoryBinding(owner.commonStats, current.stats)) return;
  const commonMetadataChanged = !sameObservation(owner.commonStats, current.stats);
  const mounts = commonMetadataChanged ? await readMounts() : original;
  if (
    !mounts ||
    !sameMount(owner.path, original, mounts) ||
    !sameMount(owner.common, original, mounts)
  )
    return;
  const checked = await discoverOwner(owner.path, mounts);
  if (
    !checked.owner ||
    checked.owner.common !== owner.common ||
    !sameDirectoryBinding(owner.ownerStats, checked.owner.ownerStats) ||
    !sameDirectoryBinding(owner.commonStats, checked.owner.commonStats)
  )
    return;
  return { owner: checked.owner, mounts, commonMetadataChanged };
}

const sectionPaths = { objects: "objects", pack: "objects/pack", worktrees: "worktrees" } as const;

export async function observeInventorySections(common: string, mounts: StorageMount[]) {
  const observe = (key: keyof typeof sectionPaths) =>
    observeStoragePath(join(common, sectionPaths[key]), mounts);
  const [objects, pack, worktrees] = await Promise.all([
    observe("objects"),
    observe("pack"),
    observe("worktrees"),
  ]);
  return { objects, pack, worktrees };
}

export async function compareInventorySections(
  common: string,
  before: Awaited<ReturnType<typeof observeInventorySections>>,
  oldMounts: StorageMount[],
  newMounts: StorageMount[],
) {
  const after = await observeInventorySections(common, newMounts);
  const changed = (key: keyof typeof sectionPaths) => {
    const first = before[key],
      last = after[key];
    if (
      first.status !== last.status ||
      !sameMount(join(common, sectionPaths[key]), oldMounts, newMounts)
    )
      return true;
    if (first.stats && last.stats) return !sameObservation(first.stats, last.stats);
    return !!first.stats !== !!last.stats;
  };
  return { objects: changed("objects"), pack: changed("pack"), worktrees: changed("worktrees") };
}
