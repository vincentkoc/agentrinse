import { coveringMount, type StorageMount } from "./storage-mounts.js";
import {
  directStorageEntries,
  fileTotals,
  observeStoragePath,
  type EntryBudget,
  type Coverage,
} from "./storage-observation.js";
import { measureCacheTree, type CacheMeasurement } from "./storage-measurement.js";

import type { Location } from "../rules/storage/location.js";

type Area = Pick<Location, "owner" | "scope" | "reason"> & {
  rule: string;
  path: string;
};
export type AreaReport = Area & {
  coverage: Coverage;
  filesystem: string | null;
  directExtent?: "complete" | "lower-bound" | "unknown";
  directDirectories?: number;
  excluded?: number;
  fileBytes?: ReturnType<typeof fileTotals>;
  measurement?: CacheMeasurement;
};

export async function observeArea(
  area: Area,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  measure = false,
  selectFile?: (name: string) => boolean,
): Promise<AreaReport> {
  const result = await observeStoragePath(area.path, mounts);
  const report: AreaReport = {
    ...area,
    filesystem: mounts ? (coveringMount(area.path, mounts)?.filesystem ?? null) : null,
    coverage: result.status,
  };
  if (!result.stats) return measure ? { ...report, measurement: { extent: "unknown" } } : report;
  if (measure) {
    if (!result.stats.isDirectory())
      return { ...report, coverage: "unexpected-kind", measurement: { extent: "unknown" } };
    const measurement = await measureCacheTree(area.path, result.stats, mounts!, budget);
    return {
      ...report,
      coverage:
        measurement.extent === "complete"
          ? "tree-complete"
          : measurement.extent === "lower-bound"
            ? "tree-partial"
            : measurement.reason === "entry-limit"
              ? "entry-limit"
              : "unavailable",
      measurement,
    };
  }
  if (area.scope === "retained") return report;
  if (area.scope === "image") {
    if (!result.stats.isFile()) return { ...report, coverage: "unexpected-kind" };
    return { ...report, fileBytes: fileTotals([result.stats]) };
  }
  const fileGroup = area.scope === "file-group";
  if (fileGroup && !selectFile)
    return { ...report, coverage: "unavailable", directExtent: "unknown" };
  const observed = await directStorageEntries(
    area.path,
    mounts!,
    budget,
    fileGroup && selectFile
      ? {
          select: selectFile,
          expected: result.stats,
        }
      : undefined,
  );
  if (!observed.observed)
    return { ...report, coverage: observed.coverage, directExtent: "unknown" };
  if (fileGroup) {
    const files = observed.entries.filter((entry) => entry.stats.isFile());
    const unique = new Map(files.map(({ stats }) => [stats.dev + ":" + stats.ino, stats]));
    return {
      ...report,
      coverage: observed.coverage,
      directExtent:
        observed.coverage === "direct-complete" && !observed.excluded ? "complete" : "lower-bound",
      excluded: observed.excluded,
      fileBytes: fileTotals([...unique.values()]),
    };
  }
  return {
    ...report,
    coverage: observed.coverage,
    directExtent:
      observed.coverage === "direct-complete" && !observed.excluded ? "complete" : "lower-bound",
    excluded: observed.excluded,
    directDirectories: observed.entries.filter((e) => e.stats.isDirectory()).length,
    fileBytes: fileTotals(observed.entries.filter((e) => e.stats.isFile()).map((e) => e.stats)),
  };
}
