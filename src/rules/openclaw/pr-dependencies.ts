import { join } from "node:path";
import {
  measureCacheTree,
  protectedStorageName,
  type CacheMeasurement,
} from "../../core/storage-measurement.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import {
  directStorageEntries,
  observeStoragePath,
  sameObservation,
  type Coverage,
  type DirectEntry,
  type EntryBudget,
} from "../../core/storage-observation.js";
import { directoryMtimeReview, defaultReviewAgeMinutes } from "./lane-caches.js";

function installationKind(name: string) {
  if (/^[a-f0-9]{64}$/u.test(name)) return "installation";
  if (/^install-[0-9]+-[A-Za-z0-9]+$/u.test(name)) return "installation-stage";
  if (/^retired-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(name))
    return "retirement-stage";
  return "unrecognized-directory";
}

type Entry = {
  path: string;
  kind: ReturnType<typeof installationKind>;
  directoryMtimeReview: ReturnType<typeof directoryMtimeReview>;
  measurement?: CacheMeasurement;
};

type Namespace = {
  path: string;
  coverage: Coverage;
  entries: Entry[];
  otherEntries: number;
  excluded: number;
};

function emptyNamespace(path: string, coverage: Coverage): Namespace {
  return { path, coverage, entries: [], otherEntries: 0, excluded: 0 };
}

// Read directory metadata only. The PR wrapper owns its lifetime ledger and live lane holds.
export async function collectPrDependencies(
  home: string,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  now: number,
  measure: boolean,
  measureTree = measureCacheTree,
  reviewAgeMinutes = defaultReviewAgeMinutes,
) {
  const root = join(home, ".cache/openclaw/pr-dependencies");
  const namespaces: Namespace[] = [];
  const report = {
    root,
    reviewAgeMinutes,
    namespaces,
    liveHolders: "unverified" as const,
    reclaimableBytes: null,
  };
  const rootObservation =
    mounts && coveringMount(home, mounts) !== coveringMount(root, mounts)
      ? { status: "mount-boundary" as const, stats: undefined }
      : await observeStoragePath(root, mounts);
  if (!rootObservation.stats) {
    namespaces.push(emptyNamespace(root, rootObservation.status));
    return report;
  }
  const pending: DirectEntry[] = [{ name: "", path: root, stats: rootObservation.stats }];
  for (const namespace of pending) {
    const { path, stats } = namespace;
    const scan = await directStorageEntries(path, mounts, budget, {
      expected: stats,
      protect: protectedStorageName,
    });
    const row = emptyNamespace(path, scan.coverage);
    row.excluded = scan.excluded;
    for (const child of scan.entries) {
      if (path === root && child.name === "v3") {
        pending.push(child);
      } else if (!child.stats.isDirectory() || child.name.startsWith(".")) {
        row.otherEntries++;
      } else {
        const kind = installationKind(child.name);
        const entry: Entry = {
          path: child.path,
          kind,
          directoryMtimeReview: directoryMtimeReview(child.stats, now, reviewAgeMinutes),
        };
        if (measure && kind !== "unrecognized-directory") {
          entry.measurement = await measureTree(child.path, child.stats, mounts!, budget);
          const after = await observeStoragePath(child.path, mounts);
          if (!after.stats || !sameObservation(child.stats, after.stats)) {
            entry.directoryMtimeReview = "unknown";
            entry.measurement = { extent: "unknown", reason: "changed" };
          }
        }
        row.entries.push(entry);
      }
    }
    namespaces.push(row);
  }
  // Withhold child evidence if the root or versioned namespace changed during measurement.
  for (const [index, namespace] of pending.entries()) {
    const after = await observeStoragePath(namespace.path, mounts);
    if (!after.stats || !sameObservation(namespace.stats, after.stats)) {
      namespaces.splice(
        index,
        namespaces.length - index,
        emptyNamespace(namespace.path, "changed"),
      );
      break;
    }
  }
  return report;
}
