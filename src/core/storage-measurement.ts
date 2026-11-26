import type { BigIntStats } from "node:fs";
import { isArtifactAgentState } from "./artifact-measurement.js";
import type { StorageMount } from "./storage-mounts.js";
import {
  directStorageEntries,
  fileTotals,
  sameFileObservation,
  type EntryBudget,
  type Coverage,
  type FileTotals,
} from "./storage-observation.js";

const protectedNames = new Set([
  ".git",
  ".hg",
  ".jj",
  ".svn",
  ".ssh",
  ".gnupg",
  ".agents",
  ".trash",
  ".aws",
  ".kube",
  "sessions",
  "archived_sessions",
  "transcripts",
  "history.jsonl",
  "auth.json",
  ".env",
  "recovery",
]);
export function protectedStorageName(name: string): boolean {
  return isArtifactAgentState(name) || protectedNames.has(name.toLowerCase());
}

export type CacheMeasurement = {
  extent: "unknown" | "complete" | "lower-bound";
  excluded?: number;
  reason?: Coverage | "unverified-receipt";
  fileBytes?: FileTotals;
};
// Called for allowlisted cache trees or an explicitly selected, receipt-verified staging tree.
export async function measureCacheTree(
  root: string,
  expected: BigIntStats,
  mounts: StorageMount[],
  budget: EntryBudget,
  list = directStorageEntries,
): Promise<CacheMeasurement> {
  const pending = [{ path: root, stats: expected }];
  const files = new Map<string, BigIntStats>();
  const changedFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  let excluded = 0;
  let rootObserved = false;
  let incomplete: Coverage | undefined;
  while (pending.length) {
    if (!budget.remaining) {
      incomplete = "entry-limit";
      break;
    }
    const directory = pending.pop()!;
    const id = directory.stats.dev + ":" + directory.stats.ino;
    if (seenDirectories.has(id)) {
      excluded++;
      continue;
    }
    seenDirectories.add(id);
    const scan = await list(directory.path, mounts, budget, {
      protect: protectedStorageName,
      expected: directory.stats,
    });
    excluded += scan.excluded;
    if (scan.coverage === "entry-limit" || scan.coverage === "direct-complete") {
      if (directory.path === root) rootObserved = true;
    } else {
      excluded++;
    }
    if (scan.coverage !== "direct-complete") incomplete = scan.coverage;
    for (const entry of scan.entries) {
      if (entry.stats.isDirectory()) {
        pending.push(entry);
        continue;
      }
      const key = entry.stats.dev + ":" + entry.stats.ino;
      if (changedFiles.has(key)) continue;
      const previous = files.get(key);
      if (previous && !sameFileObservation(previous, entry.stats)) {
        incomplete = "changed";
        changedFiles.add(key);
        files.delete(key);
        excluded++;
        continue;
      }
      files.set(key, entry.stats);
    }
  }
  const extent = !rootObserved ? "unknown" : incomplete || excluded ? "lower-bound" : "complete";
  return {
    extent,
    excluded,
    ...(incomplete ? { reason: incomplete } : {}),
    ...(rootObserved ? { fileBytes: fileTotals([...files.values()]) } : {}),
  };
}
