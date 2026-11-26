import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, dirname, join } from "node:path";
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

import {
  measureCacheTree,
  protectedStorageName,
  type CacheMeasurement,
} from "../core/storage-measurement.js";
import { collectPackStorage } from "../rules/git/pack-storage.js";
import { collectCrabboxStorage } from "../rules/openclaw/crabbox-storage.js";
import { isPathInside } from "../core/safety.js";

export type StorageOptions = {
  home: string;
  family?: string[];
  retainedRoot?: string[];
  repo?: string[];
  crabboxRoot?: string[];
  volume?: string[];
  maxEntries?: string;
  measure?: boolean;
  rule?: string[];
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
  measurement?: CacheMeasurement;
};

function literal(path: string): string {
  if (!isAbsolute(path) || /\p{Cc}/u.test(path) || resolve(path) !== path)
    throw new Error("Storage paths must be absolute and normalized");
  return path;
}

async function observeArea(
  area: Area,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  measure = false,
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
  const allowed = ["developer", "retained", "vm", "mounts", "crabbox", "git"];
  if (families.some((f) => !allowed.includes(f)))
    throw new Error("Unknown storage family; choose " + allowed.join(", "));
  const selected = (family: string) => !families.length || families.includes(family);
  const limit = options.maxEntries ?? "20000";
  if (!/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100000)
    throw new Error("--max-entries must be between 1 and 100000");
  const budget = { remaining: Number(limit) };
  const platform = deps.platform ?? process.platform;
  const catalog = localStorageLocations(home, platform);
  const rules = new Set(options.rule);
  if ([...rules].some((id) => !catalog.some((entry) => entry.id === id)))
    throw new Error("Unknown storage rule on this platform");
  const mounts = await (deps.readMounts ?? readStorageMounts)(platform);
  const retained = [...new Set((options.retainedRoot ?? []).map(literal))];
  const volumes = [...new Set((options.volume ?? []).map(literal))];
  const repos = [...new Set((options.repo ?? []).map(literal))];
  const staging = [...new Set((options.crabboxRoot ?? []).map(literal))];
  if (retained.length + volumes.length + repos.length + staging.length > 64)
    throw new Error("At most 64 explicit storage paths are supported");
  for (const path of [...repos, ...staging]) {
    if (
      isPathInside(path, home) ||
      [
        "/tmp",
        "/private/tmp",
        tmpdir(),
        "/Volumes",
        "/Users",
        "/home",
        "/var",
        "/private",
        "/opt",
        "/usr",
      ].includes(path)
    )
      throw new Error("Select a specific owner location");
    if (
      path
        .split("/")
        .some((part) =>
          [
            ".codex",
            ".claude",
            ".ssh",
            ".gnupg",
            ".Trash",
            ".agents",
            ".openclaw",
            ".config",
          ].includes(part),
        )
    )
      throw new Error("Protected owner location");
  }
  for (const path of staging) {
    if (
      path.split("/").some(protectedStorageName) ||
      [
        join(home, ".cache"),
        join(home, ".cache/openclaw"),
        join(home, ".local"),
        join(home, ".local/share"),
        join(home, "Library"),
      ].includes(path)
    )
      throw new Error("Select the staging container itself");
  }
  const gitPacks = await collectPackStorage(repos, mounts, budget);
  const crabbox = [];
  const receiptBudget = { remaining: 256 };
  for (const root of staging.length
    ? staging
    : families.includes("crabbox") || (!rules.size && selected("crabbox"))
      ? [join(home, ".cache/openclaw/crabbox-sync")]
      : []) {
    crabbox.push(
      await collectCrabboxStorage(
        root,
        mounts,
        budget,
        Date.now(),
        receiptBudget,
        Boolean(options.measure && (staging.length || families.includes("crabbox"))),
      ),
    );
  }
  const areas: AreaReport[] = [];
  for (const { id, owner, path, scope, reason, measureTree } of catalog) {
    if (rules.size && !rules.has(id)) continue;
    if (!selected(scope === "image" ? "vm" : scope === "retained" ? "retained" : "developer"))
      continue;
    const area = { rule: id, owner, path, scope, reason };
    const measure = Boolean(options.measure && measureTree);
    if (mounts && coveringMount(home, mounts) !== coveringMount(path, mounts)) {
      areas.push({
        ...area,
        filesystem: coveringMount(path, mounts)?.filesystem ?? null,
        coverage: "mount-boundary",
        ...(measure ? { measurement: { extent: "unknown" } } : {}),
      });
    } else {
      areas.push(await observeArea(area, mounts, budget, measure));
    }
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
  const partial =
    areas.some(
      (a) => a.coverage !== "missing" && a.measurement && a.measurement.extent !== "complete",
    ) ||
    areas.some((a) => ["entry-limit", "unavailable", "changed"].includes(a.coverage)) ||
    gitPacks.repositories.some(
      (r) => r.coverage !== "duplicate-store" && r.coverage !== "direct-complete",
    ) ||
    gitPacks.ambiguousFiles > 0 ||
    crabbox.some(
      (r) =>
        (r.coverage !== "direct-complete" && !(r.coverage === "missing" && !staging.length)) ||
        r.receiptsOmitted > 0 ||
        r.unverifiedEntries > 0 ||
        r.entries.some((e) => e.measurement && e.measurement.extent !== "complete"),
    );
  return {
    status: !mounts || partial ? ("degraded" as const) : ("ok" as const),
    data: {
      mountCoverage: mounts ? "available" : "unknown",
      reportedMounts: relevant.slice(0, 128),
      omittedMounts: Math.max(0, relevant.length - 128),
      volumeEvidence,
      gitPacks,
      crabbox,
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
      ...view.gitPacks.repositories.map((r) => "Git pack store  " + r.coverage + "  " + r.path),
      ...Object.entries(view.gitPacks.byKind).map(
        ([kind, g]) =>
          "Git " +
          kind +
          ": " +
          g.files +
          " files, " +
          g.logicalBytes +
          " logical / " +
          g.allocatedBytes +
          " allocated bytes",
      ),
      ...view.crabbox.flatMap((r) => [
        "Crabbox staging  " +
          r.coverage +
          "  " +
          r.root +
          "  mirror index: " +
          r.mirrorIndex +
          "; receipts omitted: " +
          r.receiptsOmitted,
        ...r.entries.map(
          (e) =>
            "  " +
            e.classification +
            "  " +
            e.path +
            ("lastUseReview" in e && e.lastUseReview ? "  " + e.lastUseReview : "") +
            (e.measurement
              ? "  " +
                e.measurement.extent +
                ("fileBytes" in e.measurement && e.measurement.fileBytes
                  ? "  " + e.measurement.fileBytes.allocatedBytes + " observed allocated bytes"
                  : " bytes unknown")
              : ""),
        ),
      ]),
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
      ...present
        .filter((a) => a.measurement)
        .map(
          (a) =>
            "Measured " +
            a.rule +
            "  " +
            a.measurement!.extent +
            "  " +
            (a.measurement!.fileBytes
              ? a.measurement!.fileBytes!.logicalBytes +
                " logical / " +
                a.measurement!.fileBytes!.allocatedBytes +
                " observed allocated bytes"
              : "bytes unknown"),
        ),
      "Default directory observations cover direct children. Snapshots, clones, hardlinks and guest allocation can share bytes.",
    ].join("\n") + "\n"
  );
}
