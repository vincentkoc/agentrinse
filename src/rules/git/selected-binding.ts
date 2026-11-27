import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitWorktreeRecord } from "../../adapters/git/porcelain.js";
import { readProjectFile } from "../../core/project-file.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import {
  observeStoragePath,
  sameDirectoryBinding,
  sameFileObservation,
} from "../../core/storage-observation.js";
import type { InventoryOwner } from "./inventory-owner.js";
import { protectedCheckout } from "./inventory-registrations.js";

export function literalGradePath(path: string) {
  return isAbsolute(path) && resolve(path) === path && !/[\p{Cc}]/u.test(path);
}

// Git writes absolute pointers or canonical relative pointers (including ../.. for commondir).
async function pointer(file: string, device: bigint, prefix = "") {
  const bytes = await readProjectFile(file, Number(device), { maxBytes: 16_384 });
  if (!bytes) return;
  const line = bytes.toString("utf8").replace(/\r?\n$/u, "");
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes) || !line.startsWith(prefix)) return;
  const value = line.slice(prefix.length);
  if (!value || /[\p{Cc}]/u.test(value)) return;
  const path = resolve(dirname(file), value);
  if (value === path || value === relative(dirname(file), path)) return path;
}

// Only open pointer files at already-admitted locations. A pointer into another owner
// never grants permission to inspect that owner or its registration slot.
export async function selectedBinding(path: string, owner: InventoryOwner, mounts: StorageMount[]) {
  const marker = join(path, ".git");
  const mount = coveringMount(path, mounts);
  if (
    !literalGradePath(path) ||
    protectedCheckout(path) ||
    mount?.access !== "local" ||
    mounts.some((entry) => entry.path === path || entry.path.startsWith(path + sep))
  )
    return;
  const checkout = (await observeStoragePath(path, mounts)).stats;
  const markerStat = (await observeStoragePath(marker, mounts)).stats;
  if (!checkout?.isDirectory() || !markerStat?.isFile() || checkout.dev !== markerStat.dev) return;
  const admin = await pointer(marker, checkout.dev, "gitdir: ");
  if (!admin || dirname(admin) !== join(owner.common, "worktrees")) return;
  const ownerMount = coveringMount(owner.common, mounts);
  if (ownerMount !== coveringMount(admin, mounts)) return;
  const adminStat = (await observeStoragePath(admin, mounts)).stats;
  if (!adminStat?.isDirectory() || adminStat.dev !== owner.commonStats.dev) return;
  const backlink = join(admin, "gitdir"),
    common = join(admin, "commondir");
  if (
    ownerMount !== coveringMount(backlink, mounts) ||
    ownerMount !== coveringMount(common, mounts) ||
    (await pointer(backlink, adminStat.dev)) !== marker ||
    (await pointer(common, adminStat.dev)) !== owner.common
  )
    return;
  return { checkout, markerStat, adminStat, admin };
}

export type SelectedBinding = NonNullable<Awaited<ReturnType<typeof selectedBinding>>>;
export function sameSelectedBinding(before: SelectedBinding, after: SelectedBinding) {
  return (
    before.admin === after.admin &&
    sameDirectoryBinding(before.checkout, after.checkout) &&
    sameFileObservation(before.markerStat, after.markerStat) &&
    sameDirectoryBinding(before.adminStat, after.adminStat)
  );
}

export function selectedRecord(records: readonly GitWorktreeRecord[], path: string) {
  const matches = records.filter((record) => record.path === path);
  return matches.length === 1 ? matches[0] : undefined;
}
