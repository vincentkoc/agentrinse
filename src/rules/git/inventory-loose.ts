import { join } from "node:path";
import { inventoryGit } from "../../adapters/git/inventory-command.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import {
  directStorageEntries,
  mapDirectStorageEntries,
  observeStoragePath,
  sameObservation,
  type EntryBudget,
} from "../../core/storage-observation.js";

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
  if (!start.stats?.isDirectory() || coveringMount(common, mounts) !== coveringMount(root, mounts))
    return result;
  const dirs = await directStorageEntries(root, mounts, budget, {
    expected: start.stats,
    select: (name) => /^[a-f\d]{2}$/u.test(name),
  });
  result.fanoutsObserved = dirs.entries.length;
  result.withheldEntries = dirs.excluded;
  if (dirs.entries.length) {
    const format = (
      await inventoryGit(
        common,
        ["--git-dir", common, "rev-parse", "--show-object-format"],
        AbortSignal.timeout(5000),
      ).catch(() => "")
    ).trim();
    if (format !== "sha1" && format !== "sha256") {
      result.coverage = "unknown-object-format";
      return result;
    }
    result.objectFormat = format;
    const suffix = format === "sha1" ? /^[a-f\d]{38}$/u : /^[a-f\d]{62}$/u;
    for (const dir of dirs.entries) {
      if (!dir.stats.isDirectory()) {
        result.withheldEntries++;
        continue;
      }
      const scan = await mapDirectStorageEntries(
        dir.path,
        mounts,
        budget,
        ({ stats }) => stats.isFile(),
        { expected: dir.stats, select: (name) => suffix.test(name) },
      );
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
    return result;
  }
  if (
    dirs.coverage === "direct-complete" &&
    !result.withheldEntries &&
    result.fanoutsObserved === result.fanoutsComplete
  )
    result.coverage = "complete";
  else if (!budget.remaining) result.coverage = "entry-limit";
  return result;
}
