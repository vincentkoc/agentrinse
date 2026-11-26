import { readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import { observeStoragePath } from "../../core/storage-observation.js";

// Darwin publishes these two fixed aliases. Ordinary symlinks never establish a checkout.
export async function inventoryPath(
  literal: string,
  mounts: StorageMount[],
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin") return literal;
  const parts = literal.split("/");
  if (parts[1] === "Volumes" && parts[2]) {
    const volume = join("/Volumes", parts[2]);
    if (coveringMount(volume, mounts)?.path !== volume) return;
  }
  if (parts[1] !== "tmp" && parts[1] !== "var") return literal;
  const alias = "/" + parts[1],
    expected = "/private" + alias;
  if (coveringMount(alias, mounts)?.access !== "local") return;
  const observed = await observeStoragePath(alias, mounts);
  if (observed.status === "stat-only") return literal;
  if (observed.status !== "linked") return;
  const target = await readlink(alias).catch(() => "");
  if (!target || posix.resolve("/", target) !== expected) return;
  return join(expected, ...parts.slice(2));
}
