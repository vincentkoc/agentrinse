import { lstat, opendir } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { coveringMount, type StorageMount } from "./storage-mounts.js";

export type Coverage =
  | "direct-complete"
  | "stat-only"
  | "missing"
  | "linked"
  | "mount-boundary"
  | "unavailable"
  | "entry-limit"
  | "changed"
  | "unexpected-kind";
export interface EntryBudget {
  remaining: number;
}
export type NativeStat = (path: string) => Promise<BigIntStats>;
const inspect: NativeStat = (path) => lstat(path, { bigint: true });
export const missingStorage = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function observeStoragePath(
  path: string,
  mounts: StorageMount[] | undefined,
  stat: NativeStat = inspect,
): Promise<{ status: Coverage; stats?: BigIntStats }> {
  if (!mounts) return { status: "unavailable" };
  if (coveringMount(path, mounts)?.access !== "local") return { status: "mount-boundary" };
  // Check components from their parent outwards, so a fixed location cannot silently follow an alias.
  const parts: string[] = [];
  let cursor = resolve(path);
  while (cursor !== parse(cursor).root) {
    parts.push(cursor);
    cursor = dirname(cursor);
  }
  parts.push(cursor);
  try {
    for (const current of parts.reverse()) {
      const info = await stat(current);
      if (info.isSymbolicLink()) return { status: "linked" };
      if (current === path) return { status: "stat-only", stats: info };
      if (!info.isDirectory()) return { status: "unexpected-kind" };
    }
  } catch (error) {
    return { status: missingStorage(error) ? "missing" : "unavailable" };
  }
  return { status: "unavailable" };
}

export function sameObservation(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export type DirectEntry = { name: string; path: string; stats: BigIntStats };
export async function directStorageEntries(
  root: string,
  mounts: StorageMount[],
  budget: EntryBudget,
): Promise<{
  coverage: Coverage;
  entries: DirectEntry[];
  excluded: number;
}> {
  const empty = (coverage: Coverage) => ({ coverage, entries: [], excluded: 0 });
  const initial = await observeStoragePath(root, mounts);
  if (!initial.stats) return empty(initial.status);
  if (!initial.stats.isDirectory()) return empty("unexpected-kind");
  if (!budget.remaining) return empty("entry-limit");
  const mountPaths = new Set(mounts.map((m) => m.path));
  const entries: DirectEntry[] = [];
  let excluded = 0,
    coverage: Coverage = "direct-complete";
  try {
    const dir = await opendir(root, { bufferSize: 1 });
    try {
      if (!sameObservation(initial.stats, await inspect(root))) return empty("changed");
      for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
        if (!budget.remaining) {
          coverage = "entry-limit";
          break;
        }
        budget.remaining--;
        const path = join(root, entry.name);
        if (mountPaths.has(path) || entry.isSymbolicLink()) {
          excluded++;
          continue;
        }
        const stats = await inspect(path);
        if (
          stats.dev !== initial.stats.dev ||
          stats.isSymbolicLink() ||
          (!stats.isFile() && !stats.isDirectory())
        ) {
          excluded++;
          continue;
        }
        entries.push({ name: entry.name, path, stats });
      }
    } finally {
      await dir.close();
    }
    const final = await observeStoragePath(root, mounts);
    if (!final.stats || !sameObservation(initial.stats, final.stats)) return empty("changed");
    return { coverage, entries, excluded };
  } catch {
    return empty("unavailable");
  }
}

export type FileTotals = { files: number; logicalBytes: string; allocatedBytes: string };
export function fileTotals(stats: BigIntStats[]): FileTotals {
  return {
    files: stats.length,
    logicalBytes: stats.reduce((n, s) => n + s.size, 0n).toString(),
    allocatedBytes: stats.reduce((n, s) => n + s.blocks * 512n, 0n).toString(),
  };
}
