import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import { redactAuditValue } from "../core/redaction.js";
import { readStorageMounts, coveringMount, type StorageMount } from "../core/storage-mounts.js";
import {
  directStorageEntries,
  fileTotals,
  observeStoragePath,
  type EntryBudget,
  type Coverage,
} from "../core/storage-observation.js";
import { localStorageLocations } from "../rules/storage/catalog.js";

export type StorageOptions = {
  home: string;
  family?: string[];
  retainedRoot?: string[];
  volume?: string[];
  maxEntries?: string;
  json?: boolean;
  redact?: boolean;
};
type Dependencies = {
  platform?: NodeJS.Platform;
  readMounts?: (platform: NodeJS.Platform) => Promise<StorageMount[] | undefined>;
};
type Area = {
  rule: string;
  owner: string;
  path: string;
  scope: "direct" | "retained" | "image";
  reason: string;
};
type AreaReport = Area & {
  coverage: Coverage;
  filesystem: string | null;
  directDirectories?: number;
  excluded?: number;
  fileBytes?: ReturnType<typeof fileTotals>;
};

function literal(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path) || resolve(path) !== path)
    throw new Error("Storage paths must be absolute and normalized");
  return path;
}

async function observeArea(
  area: Area,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
): Promise<AreaReport> {
  const result = await observeStoragePath(area.path, mounts);
  const report: AreaReport = {
    ...area,
    filesystem: mounts ? (coveringMount(area.path, mounts)?.filesystem ?? null) : null,
    coverage: result.status,
  };
  if (!result.stats) return report;
  if (area.scope === "retained") return report;
  if (area.scope === "image") {
    if (!result.stats.isFile()) return { ...report, coverage: "unexpected-kind" };
    return { ...report, fileBytes: fileTotals([result.stats]) };
  }
  const observed = await directStorageEntries(area.path, mounts!, budget);
  return {
    ...report,
    coverage: observed.coverage,
    excluded: observed.excluded,
    directDirectories: observed.entries.filter((e) => e.stats.isDirectory()).length,
    fileBytes: fileTotals(observed.entries.filter((e) => e.stats.isFile()).map((e) => e.stats)),
  };
}

export async function inventoryStorage(options: StorageOptions, deps: Dependencies = {}) {
  const home = literal(options.home);
  const families = options.family ?? [];
  const allowed = ["developer", "retained", "vm", "mounts"];
  if (families.some((f) => !allowed.includes(f)))
    throw new Error("Unknown storage family; choose " + allowed.join(", "));
  const selected = (family: string) => !families.length || families.includes(family);
  const limit = options.maxEntries ?? "20000";
  if (!/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100000)
    throw new Error("--max-entries must be between 1 and 100000");
  const budget = { remaining: Number(limit) };
  const platform = deps.platform ?? process.platform;
  const mounts = await (deps.readMounts ?? readStorageMounts)(platform);
  const retained = [...new Set((options.retainedRoot ?? []).map(literal))];
  const volumes = [...new Set((options.volume ?? []).map(literal))];
  if (retained.length + volumes.length > 64)
    throw new Error("At most 64 explicit storage paths are supported");
  const areas: AreaReport[] = [];
  for (const { id, owner, path, scope, reason } of localStorageLocations(home, platform)) {
    if (selected(scope === "image" ? "vm" : scope === "retained" ? "retained" : "developer"))
      areas.push(await observeArea({ rule: id, owner, path, scope, reason }, mounts, budget));
  }
  for (const path of retained) {
    if (path === dirname(path) || path === home)
      throw new Error("Select a specific retained location");
    areas.push(
      await observeArea(
        {
          rule: "explicit.retained",
          owner: "operator",
          path,
          scope: "retained",
          reason: "Explicit retained location; contents uninspected",
        },
        mounts,
        budget,
      ),
    );
  }
  const volumeEvidence = volumes.map((path) => ({
    path,
    coveringMount: mounts ? (coveringMount(path, mounts) ?? null) : null,
  }));
  const relevant =
    mounts?.filter(
      (m) => m.extentSharing === "possible" || m.access === "network" || m.access === "automount",
    ) ?? [];
  const partial = areas.some((a) => ["entry-limit", "unavailable", "changed"].includes(a.coverage));
  return {
    status: !mounts || partial ? ("degraded" as const) : ("ok" as const),
    data: {
      mountCoverage: mounts ? "available" : "unknown",
      reportedMounts: relevant.slice(0, 128),
      omittedMounts: Math.max(0, relevant.length - 128),
      volumeEvidence,
      areas,
      entryBudget: Number(limit),
      entriesInspected: Number(limit) - budget.remaining,
      reclaimableBytes: null,
    },
  };
}

export async function executeStorageCommand(options: StorageOptions) {
  const startedAt = new Date().toISOString();
  const { status, data } = await inventoryStorage(options);
  const view = options.redact ? redactAuditValue(data, options.home, randomUUID()) : data;
  if (options.json)
    return jsonDocument(
      createCommandEnvelope({
        command: "storage",
        startedAt,
        completedAt: new Date().toISOString(),
        status,
        data: view,
      }),
    );
  const present = view.areas.filter((a) => a.coverage !== "missing");
  return (
    [
      "Storage inventory (" +
        status +
        "). " +
        present.length +
        " observed/withheld locations, " +
        (view.areas.length - present.length) +
        " missing. Physical reclaim is unknown.",
      ...view.reportedMounts.map((m) => m.filesystem + "  " + m.access + "  " + m.path),
      ...(view.omittedMounts ? ["Additional mount records omitted: " + view.omittedMounts] : []),
      ...view.volumeEvidence.map(
        (v) =>
          "Volume " + v.path + "  " + (v.coveringMount?.filesystem ?? "unknown") + " (mount table)",
      ),
      ...present.map(
        (a) =>
          a.rule +
          "  " +
          a.coverage +
          "  " +
          a.path +
          (a.fileBytes
            ? "  " +
              a.fileBytes.logicalBytes +
              " logical / " +
              a.fileBytes.allocatedBytes +
              " allocated bytes on observed files"
            : ""),
      ),
      "Directory observations cover direct children only. Snapshots, clones, hardlinks and guest allocation can share bytes.",
    ].join("\n") + "\n"
  );
}
