import { lstat, opendir } from "node:fs/promises";
import type { BigIntStats, Dirent } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { coveringMount, mountIndex, type StorageMount } from "./storage-mounts.js";

export type Coverage =
  | "direct-complete"
  | "tree-complete"
  | "tree-partial"
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

// A directory can keep its binding while unrelated entries are created or renamed inside it.
export function sameDirectoryBinding(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isDirectory() &&
    b.isDirectory() &&
    a.ino > 0n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeNs === b.birthtimeNs &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
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

export function sameFileObservation(a: BigIntStats, b: BigIntStats): boolean {
  return sameObservation(a, b) && a.size === b.size && a.blocks === b.blocks;
}

export type DirectEntry = { name: string; path: string; stats: BigIntStats };
type DirectFilter = {
  protect?: (name: string) => boolean;
  select?: (name: string) => boolean;
  expected: BigIntStats;
};

export function directStorageEntries(
  root: string,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  filter?: DirectFilter,
) {
  return mapDirectStorageEntries(root, mounts, budget, (entry) => entry, filter);
}

// Project large Git directories into compact observations before retaining a whole store.
export async function mapDirectStorageEntries<T>(
  root: string,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  project: (entry: DirectEntry) => T,
  filter?: DirectFilter,
): Promise<{ coverage: Coverage; entries: T[]; observed: boolean; excluded: number }> {
  const empty = (coverage: Coverage) => ({ coverage, observed: false, entries: [], excluded: 0 });
  if (!mounts) return empty("unavailable");
  const initial = await observeStoragePath(root, mounts);
  if (!initial.stats) return empty(initial.status);
  if (filter && !sameObservation(filter.expected, initial.stats)) return empty("changed");
  if (!initial.stats.isDirectory()) return empty("unexpected-kind");
  if (!budget.remaining) return empty("entry-limit");
  const mountPaths = mountIndex(mounts);
  const entries: T[] = [];
  let excluded = 0,
    coverage: Coverage = "direct-complete";
  try {
    const dir = await opendir(root, { bufferSize: 128 });
    const collect = async (batch: Dirent[]) => {
      const projected = await Promise.all(
        batch.map(async (entry) => {
          const path = join(root, entry.name);
          if (filter?.protect?.(entry.name) || mountPaths.has(path) || entry.isSymbolicLink())
            return;
          const stats = await inspect(path);
          if (stats.dev !== initial.stats!.dev || (!stats.isFile() && !stats.isDirectory())) return;
          return { value: project({ name: entry.name, path, stats }) };
        }),
      );
      for (const result of projected) {
        if (result) entries.push(result.value);
        else excluded++;
      }
    };
    try {
      if (!sameObservation(initial.stats, await inspect(root))) return empty("changed");
      let batch: Dirent[] = [];
      for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
        if (!budget.remaining) {
          coverage = "entry-limit";
          break;
        }
        budget.remaining--;
        if (filter?.select && !filter.select(entry.name)) continue;
        batch.push(entry);
        if (batch.length === 32) {
          await collect(batch);
          batch = [];
        }
      }
      if (batch.length) await collect(batch);
    } finally {
      await dir.close();
    }
    const final = await observeStoragePath(root, mounts);
    if (!final.stats || !sameObservation(initial.stats, final.stats)) return empty("changed");
    return { coverage, observed: true, entries, excluded };
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
