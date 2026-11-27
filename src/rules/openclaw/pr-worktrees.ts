import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventoryGit } from "../../adapters/git/inventory-command.js";
import { parseWorktreePorcelain, type GitWorktreeRecord } from "../../adapters/git/porcelain.js";
import {
  observeStoragePath,
  sameDirectoryBinding,
  sameFileObservation,
} from "../../core/storage-observation.js";
import type { StorageMount } from "../../core/storage-mounts.js";
import { discoverOwner, type InventoryOwner } from "../git/inventory-owner.js";
import {
  selectedBinding,
  sameSelectedBinding,
  type SelectedBinding,
} from "../git/selected-binding.js";
import type { Preview } from "./pr-gc-preview.js";

export const prWorktreeRule = {
  id: "openclaw.pr-review-worktrees",
  owner: "OpenClaw scripts/pr",
  inventory: "worktrees --repo <owner> --project-roots --openclaw-pr-gc-stdin",
  requires:
    "Corroborate the native PR GC preview with direct reciprocal checkouts and current locks. Unreported PR state, holders and reclaim remain unknown.",
};

export function directPr(path: string, container: string) {
  return dirname(path) === container ? /^pr-([1-9][0-9]*)$/u.exec(basename(path))?.[1] : undefined;
}

// Same literal origin spellings as scripts/pr officialOrigin(). Do not resolve
// user rewrites, contact the remote, or run files from the checkout.
async function officialOrigin(owner: string, signal: AbortSignal) {
  const url = await inventoryGit(
    owner,
    ["config", "--local", "--no-includes", "--null", "--get-all", "remote.origin.url"],
    signal,
    { maxBuffer: 8192, rejectStderr: true },
  );
  return [
    "https://github.com/openclaw/openclaw",
    "https://github.com/openclaw/openclaw.git",
    "git@github.com:openclaw/openclaw.git",
    "ssh://git@github.com/openclaw/openclaw.git",
  ].some((value) => url === value + "\0");
}

function indexRecords(records: readonly GitWorktreeRecord[], container: string) {
  const result = new Map<string, GitWorktreeRecord | null>();
  for (const record of records.slice(1)) {
    const pr = directPr(record.path, container);
    if (pr) result.set(pr, result.has(pr) ? null : record);
  }
  return result;
}

export async function openClawPrProject(
  path: string,
  mounts: StorageMount[],
  records: GitWorktreeRecord[],
  signal: AbortSignal,
) {
  try {
    const { owner } = await discoverOwner(path, mounts);
    if (
      !owner ||
      owner.common !== join(path, ".git") ||
      records[0]?.path !== path ||
      !(await officialOrigin(path, signal))
    )
      return;
    const container = join(path, ".worktrees");
    return {
      owner,
      container,
      records: indexRecords(records, container),
      bindings: new Map<string, SelectedBinding>(),
    };
  } catch {
    return;
  }
}
export type PrProject = NonNullable<Awaited<ReturnType<typeof openClawPrProject>>>;

async function currentEvidence(project: PrProject, mounts: StorageMount[], signal: AbortSignal) {
  const owner = project.owner;
  const current = (await discoverOwner(owner.path, mounts)).owner;
  if (!current || !sameOwner(owner, current) || !(await officialOrigin(owner.path, signal))) return;
  const records = parseWorktreePorcelain(
    await inventoryGit(owner.path, ["worktree", "list", "--porcelain", "-z"], signal, {
      rejectStderr: true,
    }),
  );
  if (records[0]?.path !== owner.path) return;
  const output = await inventoryGit(
    owner.path,
    ["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks/"],
    signal,
    { maxBuffer: 1024 * 1024, rejectStderr: true },
  );
  const locks = new Set<string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const match = /^refs\/openclaw\/pr-operation-locks\/([1-9][0-9]*)$/u.exec(line);
    if (!match) return;
    locks.add(match[1]!);
  }
  return { records: indexRecords(records, project.container), locks };
}
function sameOwner(before: InventoryOwner, after: InventoryOwner) {
  return (
    after.common === before.common &&
    sameDirectoryBinding(before.ownerStats, after.ownerStats) &&
    sameDirectoryBinding(before.commonStats, after.commonStats)
  );
}

async function untrackedCheckoutMaterial(
  path: string,
  admin: string,
  mounts: StorageMount[],
  signal: AbortSignal,
) {
  try {
    const index = join(admin, "index");
    const before = (await observeStoragePath(index, mounts)).stats;
    if (!before?.isFile() || before.nlink !== 1n) return "unknown";
    // Deliberately omit exclusion rules: directory entries include ignored proof
    // and ordinary untracked files. Never open their contents or print their names.
    const names = await inventoryGit(
      path,
      [
        "--git-dir",
        admin,
        "--work-tree",
        path,
        "-c",
        "core.untrackedCache=false",
        "ls-files",
        "--others",
        "--directory",
        "--no-empty-directory",
        "-z",
      ],
      signal,
      { timeoutMs: 3_000, maxBuffer: 64 * 1024, rejectStderr: true },
    );
    const after = (await observeStoragePath(index, mounts)).stats;
    if (!after || !sameFileObservation(before, after)) return "unknown";
    if (!names) return "none-observed";
    return names.endsWith("\0") ? "present" : "unknown";
  } catch {
    return "unknown";
  }
}

type Observed = {
  path: string;
  kind: string;
  locked?: boolean;
  prunable?: boolean;
  size?: { status: string; logicalBytes: number | null };
};
export async function reportPrWorktrees(
  path: string,
  project: PrProject | undefined,
  preview: Preview | undefined,
  entries: readonly Observed[],
  containerAvailable: boolean,
  mounts: StorageMount[] | undefined,
  signal: AbortSignal,
  readNativeEvidence = currentEvidence,
) {
  const container = join(path, ".worktrees");
  const observed = new Map<string, Observed>();
  for (const entry of entries) {
    const pr = directPr(entry.path, container);
    if (pr) observed.set(pr, entry);
  }
  const prs = new Set([
    ...observed.keys(),
    ...(project?.records.keys() ?? []),
    ...(preview?.rows.keys() ?? []),
  ]);
  const current =
    project && containerAvailable && mounts && preview
      ? await readNativeEvidence(project, mounts, signal).catch(() => undefined)
      : undefined;
  let currentNativeEvidence = preview ? (current ? "available" : "unavailable") : "not-requested";
  const rows = [];
  let probes = 0;
  for (const pr of [...prs].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const item = observed.get(pr),
      claim = preview?.rows.get(pr);
    const first = project?.records.get(pr),
      last = current?.records.get(pr);
    const rowPath = join(container, "pr-" + pr);
    let grade: "unknown" | "skipped" | "eligible-for-owner-review" = "unknown";
    let reason = "unreported";
    let corroborated = false;
    let untrackedOrIgnored: "not-inspected" | "present" | "none-observed" | "unknown" =
      "not-inspected";
    if (
      claim?.native === "would-remove" &&
      project &&
      mounts &&
      item?.kind === "registered-linked" &&
      current &&
      first &&
      isDeepStrictEqual(first, last) &&
      !signal.aborted
    ) {
      const before = project.bindings.get(pr);
      const after =
        before && (await selectedBinding(rowPath, project.owner, mounts).catch(() => undefined));
      corroborated = !!before && !!after && sameSelectedBinding(before, after);
      if (
        corroborated &&
        after &&
        preview?.source !== "invalid" &&
        !item.locked &&
        !item.prunable &&
        !current.locks.has(pr)
      ) {
        untrackedOrIgnored =
          ++probes <= 512
            ? await untrackedCheckoutMaterial(rowPath, after.admin, mounts, signal)
            : "unknown";
        const final = await selectedBinding(rowPath, project.owner, mounts).catch(() => undefined);
        if (!final || !sameSelectedBinding(after, final)) {
          corroborated = false;
          untrackedOrIgnored = "unknown";
        }
      }
    }
    if (!project || !containerAvailable) reason = "owner-or-container-unverified";
    else if (preview?.source === "invalid") reason = "invalid-preview";
    else if (claim?.native === "skipped") {
      grade = "skipped";
      reason = claim.reason;
    } else if (claim?.native === "failed-template") reason = "failed-template-requires-owner";
    else if (
      item?.locked ||
      item?.prunable ||
      last?.locked !== undefined ||
      last?.prunable !== undefined ||
      current?.locks.has(pr)
    ) {
      grade = "skipped";
      reason = "native-lock-or-prunable";
    } else if (!item || item.kind !== "registered-linked" || !first) reason = "checkout-unverified";
    else if (!claim) reason = preview ? "absent-from-preview" : "no-preview";
    else if (!corroborated) reason = "current-native-evidence-unavailable";
    else if (untrackedOrIgnored === "present") {
      grade = "skipped";
      reason = "untracked-or-ignored-material-needs-review";
    } else if (untrackedOrIgnored !== "none-observed")
      reason = "untracked-or-ignored-material-unverified";
    else if (preview?.source === "owner-bound-complete") {
      grade = "eligible-for-owner-review";
      reason = "corroborated-preview";
    } else reason = "preview-origin-or-completion-unverified";
    const size = claim?.native === "would-remove" && !corroborated ? null : (item?.size ?? null);
    rows.push({
      pr,
      path: rowPath,
      checkout: item?.kind ?? "unobserved",
      native: claim?.native ?? "unreported",
      ...(claim?.native === "would-remove" ? { prState: claim.prState } : {}),
      grade,
      reason,
      corroborated,
      untrackedOrIgnored,
      size,
    });
  }
  // Held registration, HEAD and owner-lock evidence can change during a large
  // untracked-file pass; withdraw only observations affected by the new snapshot.
  if (project && mounts && current && rows.some((row) => row.corroborated)) {
    const final = await readNativeEvidence(project, mounts, signal).catch(() => undefined);
    if (!final) currentNativeEvidence = "unavailable";
    for (const row of rows) {
      if (!row.corroborated) continue;
      if (!final || !isDeepStrictEqual(current.records.get(row.pr), final.records.get(row.pr))) {
        if (final) currentNativeEvidence = "partial";
        row.corroborated = false;
        row.grade = "unknown";
        row.reason = "registration-changed-or-unavailable";
        row.size = null;
      } else if (final.locks.has(row.pr)) {
        row.grade = "skipped";
        row.reason = "native-lock-or-prunable";
      }
    }
  }
  const reported = rows.filter((row) => row.native === "would-remove");
  const measured = reported.filter((row) => row.size?.logicalBytes != null);
  return {
    rule: prWorktreeRule.id,
    ownerRepository: path,
    ownerVerified: !!project,
    containerAvailable,
    currentNativeEvidence,
    source: preview?.source ?? "not-supplied",
    invalidLines: preview?.invalidLines ?? 0,
    duplicateRows: preview?.duplicateRows ?? 0,
    excludedNonPrNames: preview?.excludedNonPrNames ?? 0,
    preservationDiagnostics: preview?.preservationDiagnostics ?? 0,
    lockRecoveryDiagnostics: preview?.lockRecoveryDiagnostics ?? 0,
    summary: {
      reportedWouldRemove: reported.length,
      reportedSkipped: rows.filter((row) => row.native === "skipped").length,
      reportedFailedTemplates: rows.filter((row) => row.native === "failed-template").length,
      corroboratedWouldRemove: reported.filter((row) => row.corroborated).length,
      untrackedOrIgnoredPresent: reported.filter((row) => row.untrackedOrIgnored === "present")
        .length,
      untrackedOrIgnoredUnknown: reported.filter((row) => row.untrackedOrIgnored === "unknown")
        .length,
      ownerReview: rows.filter((row) => row.grade === "eligible-for-owner-review").length,
      skipped: rows.filter((row) => row.grade === "skipped").length,
      unknown: rows.filter((row) => row.grade === "unknown").length,
      reportedCheckoutLogicalBytes: measured.length
        ? measured.reduce((total, row) => total + row.size!.logicalBytes!, 0)
        : null,
      reportedSizesComplete: reported.filter((row) => row.size?.status === "complete").length,
      reportedSizesPartial: reported.filter((row) => row.size?.status === "lower-bound").length,
      reportedSizesUnknown: reported.length - measured.length,
      reclaimableBytes: null,
    },
    rows,
  };
}
