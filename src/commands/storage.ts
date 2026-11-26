import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import { redactAuditValue } from "../core/redaction.js";
import { readStorageMounts, coveringMount, type StorageMount } from "../core/storage-mounts.js";
import { observeArea, type AreaReport } from "../core/storage-area.js";
import { protectedStorageName } from "../core/storage-measurement.js";
import { literal, selectStorageLocations } from "./storage-selection.js";
import { inspectNativeVolume } from "../rules/storage/native-volume.js";
import { storageFamily } from "../rules/storage/location.js";
import { localStorageLocations } from "../rules/storage/catalog.js";
import { formatStorageReport } from "./storage-output.js";
import { collectPackStorage } from "../rules/git/pack-storage.js";
import { collectCrabboxStorage } from "../rules/openclaw/crabbox-storage.js";
import { isPathInside } from "../core/safety.js";

export type StorageOptions = {
  home: string;
  family?: string[];
  retainedRoot?: string[];
  at?: string[];
  project?: string[];
  system?: boolean;
  repo?: string[];
  crabboxRoot?: string[];
  volume?: string[];
  nativeVolume?: string[];
  maxEntries?: string;
  measure?: boolean;
  rule?: string[];
  json?: boolean;
  redact?: boolean;
};
type Dependencies = {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  readMounts?: (platform: NodeJS.Platform) => Promise<StorageMount[] | undefined>;
};
export async function inventoryStorage(options: StorageOptions, deps: Dependencies = {}) {
  const home = literal(options.home);
  const nativeOnly =
    options.nativeVolume?.length &&
    !options.family?.length &&
    !options.rule?.length &&
    !options.at?.length &&
    !options.project?.length &&
    !options.system;
  const families = nativeOnly ? ["mounts"] : (options.family ?? []);
  const allowed = ["developer", "retained", "vm", "mounts", "crabbox", "git"];
  if (families.some((f) => !allowed.includes(f)))
    throw new Error("Unknown storage family; choose " + allowed.join(", "));
  const selected = (family: string) => !families.length || families.includes(family);
  const limit = options.maxEntries ?? "20000";
  if (!/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 100000)
    throw new Error("--max-entries must be between 1 and 100000");
  const budget = { remaining: Number(limit) };
  const platform = deps.platform ?? process.platform;
  const catalog = localStorageLocations(home, platform, deps.systemRoot);
  const { rules, supplied, projects, projectAreas, explicitLocations } = selectStorageLocations(
    options,
    home,
    catalog,
  );
  const mounts = await (deps.readMounts ?? readStorageMounts)(platform);
  const retained = [...new Set((options.retainedRoot ?? []).map(literal))];
  const volumes = [...new Set((options.volume ?? []).map(literal))];
  const nativeVolumes = [...new Set((options.nativeVolume ?? []).map(literal))];
  if (nativeVolumes.length > 8) throw new Error("At most eight native volumes may be requested");
  const repos = [...new Set((options.repo ?? []).map(literal))];
  const staging = [...new Set((options.crabboxRoot ?? []).map(literal))];
  if (
    retained.length +
      projects.length +
      supplied.length +
      nativeVolumes.length +
      volumes.length +
      repos.length +
      staging.length >
    64
  )
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
    : families.includes("crabbox") || (!explicitLocations && selected("crabbox"))
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
  for (const { id, owner, path, scope, reason, measureTree, optIn, base, selectFile } of catalog) {
    const requested = rules.has(id) || (base === "system" && options.system);
    if (!requested && (explicitLocations || optIn)) continue;
    if (!selected(storageFamily(scope))) continue;
    const area = { rule: id, owner, path, scope, reason };
    const measure = Boolean(options.measure && measureTree);
    if (
      base !== "system" &&
      mounts &&
      coveringMount(home, mounts) !== coveringMount(path, mounts)
    ) {
      areas.push({
        ...area,
        filesystem: coveringMount(path, mounts)?.filesystem ?? null,
        coverage: "mount-boundary",
        ...(measure ? { measurement: { extent: "unknown" } } : {}),
      });
    } else {
      areas.push(await observeArea(area, mounts, budget, measure, selectFile));
    }
  }
  for (const { project, ...area } of projectAreas) {
    if (!selected("retained")) continue;
    if (mounts && coveringMount(project, mounts) !== coveringMount(area.path, mounts)) {
      areas.push({
        ...area,
        coverage: "mount-boundary",
        filesystem: coveringMount(area.path, mounts)?.filesystem ?? null,
      });
    } else {
      areas.push(await observeArea(area, mounts, budget));
    }
  }
  for (const area of supplied) {
    if (selected("retained")) areas.push(await observeArea(area, mounts, budget));
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
  const nativeVolumeEvidence = [];
  for (const path of nativeVolumes)
    nativeVolumeEvidence.push(
      await inspectNativeVolume(path, platform, deps.readMounts ?? readStorageMounts),
    );
  const volumeEvidence = volumes.map((path) => ({
    path,
    coveringMount: mounts ? (coveringMount(path, mounts) ?? null) : null,
  }));
  const relevant =
    mounts?.filter(
      (m) => m.extentSharing === "possible" || m.access === "network" || m.access === "automount",
    ) ?? [];
  const partial =
    nativeVolumeEvidence.some((v) => v.status !== "observed") ||
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
        r.excluded > 0 ||
        r.entries.some((e) => e.measurement && e.measurement.extent !== "complete"),
    );
  return {
    status: !mounts || partial ? ("degraded" as const) : ("ok" as const),
    data: {
      mountCoverage: mounts ? "available" : "unknown",
      reportedMounts: relevant.slice(0, 128),
      omittedMounts: Math.max(0, relevant.length - 128),
      volumeEvidence,
      ...(nativeVolumes.length ? { nativeVolumeEvidence } : {}),
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
  return formatStorageReport(view, status);
}
