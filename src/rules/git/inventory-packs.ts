import { join } from "node:path";
import { packFileKind } from "./pack-storage.js";
import {
  GitNameTotals,
  temporaryName,
  gitFileObservation,
  type GitFileKind,
  type GitIdentityLedger,
} from "./inventory-bytes.js";
import {
  mapDirectStorageEntries,
  observeStoragePath,
  sameObservation,
  type EntryBudget,
} from "../../core/storage-observation.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";

function packName(name: string): GitFileKind {
  const type = packFileKind(name);
  if (
    type === "temporary-index-name" ||
    type === "temporary-pack-name" ||
    type === "other-temporary-name"
  )
    return type;
  if (name === "multi-pack-index") return "multi-pack-index";
  if (type === "index") return name.endsWith(".rev") ? "reverse-index" : "index";
  if (type === "pack-sidecar") {
    if (name.endsWith(".promisor")) return "promisor";
    if (name.endsWith(".keep")) return "keep";
    if (name.endsWith(".mtimes")) return "cruft-mtimes";
    return "bitmap";
  }
  return type;
}
export async function inventoryPackStore(
  common: string,
  mounts: StorageMount[],
  budget: EntryBudget,
  ledger: GitIdentityLedger,
) {
  const objects = join(common, "objects"),
    pack = join(objects, "pack");
  const totals = new GitNameTotals(),
    pairs = new Map<string, number>();
  const base = await observeStoragePath(objects, mounts);
  const objectMount = coveringMount(objects, mounts);
  const scratch =
    base.stats?.isDirectory() && objectMount === coveringMount(common, mounts)
      ? await mapDirectStorageEntries(
          objects,
          mounts,
          budget,
          ({ name, stats }) => ({
            maintenanceLock: name === "maintenance.lock",
            file: stats.isFile() ? gitFileObservation("bitmap-ref-tips-name", stats) : null,
          }),
          {
            expected: base.stats,
            select: (n) => n === "maintenance.lock" || n.startsWith("bitmap-ref-tips_"),
          },
        )
      : {
          coverage: base.status === "stat-only" ? ("mount-boundary" as const) : base.status,
          excluded: 0,
          entries: [],
        };
  let lockPresent: boolean | null =
    scratch.coverage === "direct-complete" && scratch.excluded === 0 ? false : null;
  let unexpected = 0;
  for (const row of scratch.entries) {
    if (row.maintenanceLock) {
      lockPresent = true;
      continue;
    }
    if (row.file) {
      ledger.observe(row.file);
      totals.observe(row.file);
    } else unexpected++;
  }
  const withinStore =
    objectMount &&
    objectMount === coveringMount(common, mounts) &&
    objectMount === coveringMount(pack, mounts);
  const initialPack = withinStore ? await observeStoragePath(pack, mounts) : undefined;
  const packs = withinStore
    ? await mapDirectStorageEntries(pack, mounts, budget, ({ name, path, stats }) => {
        const kind = packName(name);
        return {
          file: stats.isFile() ? gitFileObservation(kind, stats) : null,
          temporaryPath: temporaryName(kind) ? path : null,
          changed: false,
          pair: kind === "pack" || kind === "index" ? name.slice(0, name.lastIndexOf(".")) : null,
        };
      })
    : { coverage: "mount-boundary" as const, excluded: 0, entries: [] };
  // A writer can grow an existing temporary pack without changing its parent directory.
  const temporaries = packs.entries.filter((row) => row.temporaryPath && row.file);
  for (let start = 0; start < temporaries.length; start += 32) {
    await Promise.all(
      temporaries.slice(start, start + 32).map(async (row) => {
        try {
          const now = (await observeStoragePath(row.temporaryPath!, mounts)).stats;
          if (!now) {
            row.changed = true;
            return;
          }
          const observed = gitFileObservation(row.file!.kind, now);
          row.changed =
            !now.isFile() ||
            observed.key !== row.file!.key ||
            observed.stamp !== row.file!.stamp ||
            observed.logical !== row.file!.logical ||
            observed.allocated !== row.file!.allocated ||
            observed.links !== row.file!.links;
        } catch {
          row.changed = true;
        }
      }),
    );
  }
  const finalPack = withinStore ? await observeStoragePath(pack, mounts) : undefined;
  const changedDirectory =
    initialPack?.status !== finalPack?.status ||
    (initialPack?.stats &&
      (!finalPack?.stats || !sameObservation(initialPack.stats, finalPack.stats)));
  if (changedDirectory) {
    packs.entries.length = 0;
    packs.coverage = "changed";
  }
  for (const row of packs.entries) {
    if (!row.file) {
      unexpected++;
      continue;
    }
    ledger.observe(row.file, row.changed);
    if (!row.changed) totals.observe(row.file);
    if (row.pair)
      pairs.set(row.pair, (pairs.get(row.pair) ?? 0) | (row.file.kind === "pack" ? 1 : 2));
  }
  let withoutIndex = 0,
    withoutPack = 0;
  for (const mask of pairs.values()) {
    if (mask === 1) withoutIndex++;
    if (mask === 2) withoutPack++;
  }
  const pairsComplete =
    packs.coverage === "direct-complete" && packs.excluded === 0 && unexpected === 0;
  return {
    packCoverage: packs.coverage,
    objectRootCoverage: scratch.coverage,
    excluded: packs.excluded + scratch.excluded + unexpected,
    changedTemporaryNames: temporaries.filter((row) => row.changed).length,
    observedNamesByKind: totals.report(),
    maintenanceLockNamePresent: lockPresent,
    pairs: {
      complete: pairsComplete,
      packWithoutIndex: pairsComplete ? withoutIndex : null,
      indexWithoutPack: pairsComplete ? withoutPack : null,
    },
  };
}
