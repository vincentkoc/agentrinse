import { join } from "node:path";
import { inventoryGit } from "../../adapters/git/inventory-command.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import {
  directStorageEntries,
  mapDirectStorageEntries,
  observeStoragePath,
  sameDirectoryBinding,
  sameObservation,
  type EntryBudget,
} from "../../core/storage-observation.js";

export async function gitObjectFormat(common: string) {
  return (
    await inventoryGit(
      common,
      ["--git-dir", common, "rev-parse", "--show-object-format"],
      AbortSignal.timeout(5000),
    ).catch(() => "")
  ).trim();
}

export async function inventoryLooseObjects(
  common: string,
  mounts: StorageMount[],
  budget: EntryBudget,
) {
  const root = join(common, "objects"),
    start = await observeStoragePath(root, mounts);
  const result = {
    coverage: "partial",
    objectFormat: null as string | null,
    regularNames: 0,
    fanoutsObserved: 0,
    fanoutsComplete: 0,
    withheldEntries: 0,
  };
  let verifyFanouts = async (_mounts: StorageMount[]) => false;
  const observation = {
    report: result,
    verifyFanouts: (mounts: StorageMount[]) => verifyFanouts(mounts),
  };
  const objectMount = coveringMount(root, mounts);
  if (!start.stats?.isDirectory() || coveringMount(common, mounts) !== objectMount)
    return observation;
  const dirs = await directStorageEntries(root, mounts, budget, {
    expected: start.stats,
    select: (name) => /^[a-f\d]{2}$/u.test(name),
  });
  // If another direct entry (such as pack/) changes later, compare the bounded two-hex
  // directory set. Its file contents do not need a second traversal.
  const rootStats = start.stats;
  const fanoutStamps = new Map(dirs.entries.map((entry) => [entry.name, entry.stats]));
  verifyFanouts = async (currentMounts: StorageMount[]) => {
    const current = await observeStoragePath(root, currentMounts);
    if (
      !current.stats ||
      !sameDirectoryBinding(rootStats, current.stats) ||
      dirs.coverage !== "direct-complete" ||
      dirs.excluded
    )
      return false;
    const fresh = await directStorageEntries(root, currentMounts, budget, {
      expected: current.stats,
      select: (name) => /^[a-f\d]{2}$/u.test(name),
    });
    return (
      fresh.coverage === "direct-complete" &&
      !fresh.excluded &&
      fanoutStamps.size === fresh.entries.length &&
      fresh.entries.every((entry) => {
        const first = fanoutStamps.get(entry.name);
        return first && sameObservation(first, entry.stats);
      })
    );
  };
  result.fanoutsObserved = dirs.entries.length;
  result.withheldEntries = dirs.excluded;
  if (dirs.entries.length) {
    const format = await gitObjectFormat(common);
    if (format !== "sha1" && format !== "sha256") {
      result.coverage = "unknown-object-format";
      return observation;
    }
    result.objectFormat = format;
    const suffix = format === "sha1" ? /^[a-f\d]{38}$/u : /^[a-f\d]{62}$/u;
    for (const dir of dirs.entries) {
      // Discovery establishes the directory binding. Start the enumeration window at its own read.
      if (!dir.stats.isDirectory() || coveringMount(dir.path, mounts) !== objectMount) {
        result.withheldEntries++;
        continue;
      }
      const current = await observeStoragePath(dir.path, mounts);
      if (!current.stats || !sameDirectoryBinding(dir.stats, current.stats)) {
        result.withheldEntries++;
        continue;
      }
      const scan = await mapDirectStorageEntries(
        dir.path,
        mounts,
        budget,
        ({ stats }) => stats.isFile(),
        { expected: current.stats, select: (name) => suffix.test(name) },
      );
      if (scan.observed) fanoutStamps.set(dir.name, current.stats);
      let irregular = scan.excluded;
      for (const regular of scan.entries) {
        if (regular) result.regularNames++;
        else irregular++;
      }
      result.withheldEntries += irregular;
      if (scan.coverage === "direct-complete" && !irregular) result.fanoutsComplete++;
    }
  }
  const end = await observeStoragePath(root, mounts);
  if (!end.stats || !sameObservation(start.stats, end.stats)) {
    result.coverage = "changed";
    result.regularNames = 0;
    return observation;
  }
  if (
    dirs.coverage === "direct-complete" &&
    !result.withheldEntries &&
    result.fanoutsObserved === result.fanoutsComplete
  )
    result.coverage = "complete";
  else if (!budget.remaining) result.coverage = "entry-limit";
  return observation;
}
