import type { BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { inventoryGit } from "../../adapters/git/inventory-command.js";
import { parseWorktreePorcelain, type GitWorktreeRecord } from "../../adapters/git/porcelain.js";
import {
  observeStoragePath,
  directStorageEntries,
  mapDirectStorageEntries,
  sameObservation,
  type EntryBudget,
} from "../../core/storage-observation.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import { protectedStorageName } from "../../core/storage-measurement.js";
import { readProjectFile } from "../../core/project-file.js";
import { isPathInside } from "../../core/safety.js";
import { GitNameTotals, gitFileObservation, type GitIdentityLedger } from "./inventory-bytes.js";
import {
  nativeReview,
  finishedEvidence,
  lifecycleEvidence,
  type GitLifecycleInput,
} from "./inventory-lifecycle.js";
import { inventoryPath } from "./inventory-path.js";

type Owner = { path: string; common: string; ownerStats: BigIntStats; commonStats: BigIntStats };
type Observed = Awaited<ReturnType<typeof observeStoragePath>>;
type Slot = {
  admin: string;
  stats: BigIntStats;
  literal: string;
  path: string;
  checkout: Observed;
  marker: Observed | undefined;
};
export type Registration = {
  path: string;
  scope: string;
  presence: "missing" | "reciprocal" | "present-unverified" | "withheld";
  source: "git-porcelain" | "admin-backlink";
  nativeListed: boolean | null;
  prunable: boolean | null;
  locked: boolean | null;
  lifecycle: ReturnType<typeof lifecycleEvidence>["lifecycle"];
  ownerSignoff: ReturnType<typeof lifecycleEvidence>["ownerSignoff"];
  nativeReview: ReturnType<typeof nativeReview>;
  finishedEvidence: ReturnType<typeof finishedEvidence>;
  missingAdmin?: {
    coverage: string;
    excluded: number;
    directNames: ReturnType<GitNameTotals["report"]>;
  };
};

async function textFile(file: string, device: bigint, mounts: StorageMount[]) {
  if (coveringMount(file, mounts) !== coveringMount(dirname(file), mounts)) return;
  const raw = await readProjectFile(file, Number(device), { maxBytes: 16384 });
  if (!raw || !Buffer.from(raw.toString("utf8")).equals(raw)) return;
  const text = raw.toString("utf8").replace(/\r?\n$/u, "");
  if (!/[\0\r\n]/u.test(text)) return text;
}
async function pointer(file: string, device: bigint, mounts: StorageMount[], prefix = "") {
  const text = await textFile(file, device, mounts);
  if (text?.startsWith(prefix) && text.slice(prefix.length))
    return resolve(dirname(file), text.slice(prefix.length));
}
function scope(path: string, owner: string, roots: string[]) {
  if (
    [join(owner, ".worktrees"), join(owner, "worktrees"), join(owner, ".claude", "worktrees")].some(
      (root) => isPathInside(root, path),
    )
  )
    return "project-local";
  if (roots.some((root) => isPathInside(root, path))) return "managed-container";
  return "external";
}
function protectedCheckout(path: string) {
  const parts = path.split(sep);
  return parts.some(
    (part, i) =>
      protectedStorageName(part) &&
      !([".codex", ".claude"].includes(part) && parts[i + 1] === "worktrees"),
  );
}
function githubOrigin(value: string) {
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u
    .exec(value.trim())?.[1]
    ?.toLowerCase();
}
async function readSlot(admin: string, stats: BigIntStats, owner: Owner, mounts: StorageMount[]) {
  const backlink = join(admin, "gitdir");
  const target = await pointer(backlink, stats.dev, mounts);
  if (!target || basename(target) !== ".git") {
    const state = await observeStoragePath(backlink, mounts);
    return {
      reason: state.status === "missing" ? "absent-backlink" : "invalid-backlink",
      inert: state.status === "missing",
    };
  }
  const common = await pointer(join(admin, "commondir"), stats.dev, mounts);
  if (!common || (await inventoryPath(common, mounts)) !== owner.common)
    return { reason: "common-binding", inert: false };
  const literal = dirname(target),
    physical = await inventoryPath(literal, mounts);
  if (!physical || protectedCheckout(physical))
    return { reason: "withheld-checkout", inert: false };
  const checkout = await observeStoragePath(physical, mounts);
  const marker = checkout.stats?.isDirectory()
    ? await observeStoragePath(join(physical, ".git"), mounts)
    : undefined;
  const local =
    checkout.status === "missing" ||
    (marker !== undefined &&
      (marker.status === "missing" || marker.stats?.isFile() === true) &&
      coveringMount(physical, mounts) === coveringMount(join(physical, ".git"), mounts));
  return { slot: { admin, stats, literal, path: physical, checkout, marker }, local };
}
async function lockFor(slot: Slot, mounts: StorageMount[]) {
  const path = join(slot.admin, "locked"),
    observed = await observeStoragePath(path, mounts);
  if (observed.status === "missing") return { known: true };
  if (observed.stats?.isFile()) {
    const reason = await textFile(path, slot.stats.dev, mounts);
    if (reason !== undefined) return { known: true, reason };
  }
  return { known: false };
}
async function reciprocal(slot: Slot, mounts: StorageMount[]) {
  if (!slot.checkout.stats?.isDirectory() || !slot.marker?.stats?.isFile()) return false;
  const target = await pointer(
    join(slot.path, ".git"),
    slot.checkout.stats.dev,
    mounts,
    "gitdir: ",
  );
  return !!target && (await inventoryPath(target, mounts)) === slot.admin;
}
async function adminRecord(
  owner: Owner,
  slot: Slot,
  mounts: StorageMount[],
): Promise<GitWorktreeRecord | undefined> {
  const lock = await lockFor(slot, mounts);
  if (!lock.known) return;
  const ref = await textFile(join(slot.admin, "HEAD"), slot.stats.dev, mounts);
  if (!ref) return;
  const branch = ref.startsWith("ref: refs/heads/") ? ref.slice(5) : undefined;
  const head = branch
    ? (
        await inventoryGit(
          owner.path,
          ["--git-dir", slot.admin, "rev-parse", "--verify", "HEAD"],
          AbortSignal.timeout(5000),
        ).catch(() => "")
      ).trim()
    : ref;
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(head)) return;
  return {
    path: slot.path,
    head,
    ...(branch ? { branch } : {}),
    detached: !branch,
    bare: false,
    ...(lock.reason === undefined ? {} : { locked: lock.reason }),
  };
}
async function review(
  slot: Slot,
  owner: Owner,
  roots: string[],
  mounts: StorageMount[],
  inputs: GitLifecycleInput,
  record: GitWorktreeRecord,
  repo: string | undefined,
) {
  const current = {
    owner: owner.path,
    common: owner.common,
    admin: slot.admin,
    repo,
    record,
    roots,
    checkoutStats: slot.checkout.stats!,
    adminStats: slot.stats,
    commonStats: owner.commonStats,
    ownerStats: owner.ownerStats,
  };
  const grade = nativeReview(inputs, slot.path, current);
  if (grade !== "review-native-closeout") return grade;
  // The native listing, filesystem pointers and enrollment were observed at different times.
  const fresh = await readSlot(slot.admin, slot.stats, owner, mounts);
  const checked = await adminRecord(owner, slot, mounts);
  if (
    !fresh.slot ||
    fresh.slot.path !== slot.path ||
    !(await reciprocal(fresh.slot, mounts)) ||
    !checked ||
    checked.head !== record.head ||
    checked.branch !== record.branch ||
    checked.locked !== record.locked
  )
    return "binding-mismatch";
  for (const [path, stats] of [
    [slot.path, current.checkoutStats],
    [slot.admin, slot.stats],
    [owner.common, owner.commonStats],
    [owner.path, owner.ownerStats],
  ] as const) {
    const observed = await observeStoragePath(path, mounts);
    if (!observed.stats || !sameObservation(stats, observed.stats)) return "identity-mismatch";
  }
  return grade;
}

export async function inventoryRegistrations(
  owner: Owner,
  roots: string[],
  mounts: StorageMount[],
  budget: EntryBudget,
  slotsBudget: EntryBudget,
  ledger: GitIdentityLedger,
  statuses: GitLifecycleInput,
) {
  const base = join(owner.common, "worktrees"),
    entries: Registration[] = [];
  const reasons: Record<string, number> = {};
  const issue = (code: string) => {
    reasons[code] = (reasons[code] ?? 0) + 1;
  };
  if (coveringMount(base, mounts) !== coveringMount(owner.common, mounts))
    return { coverage: "mount-boundary", entries, reasons: { mountBoundary: 1 } };
  const scan = await directStorageEntries(base, mounts, slotsBudget);
  if (scan.coverage === "missing") return { coverage: "complete", entries, reasons };
  const slots: Slot[] = [];
  let nativeSafe = scan.coverage === "direct-complete" && scan.excluded === 0;
  for (const entry of scan.entries) {
    if (!entry.stats.isDirectory()) {
      issue("unexpected-admin-entry");
      continue;
    }
    const result = await readSlot(entry.path, entry.stats, owner, mounts);
    if (result.slot) {
      slots.push(result.slot);
      nativeSafe &&= !!result.local;
    } else {
      issue(result.reason!);
      nativeSafe &&= !!result.inert;
    }
  }
  if (scan.excluded) reasons["withheld-admin-entry"] = scan.excluded;
  const native = new Map<string, GitWorktreeRecord[]>(),
    seenPaths = new Map<string, number>();
  let listed = false;
  if (nativeSafe) {
    try {
      const records = parseWorktreePorcelain(
        await inventoryGit(
          owner.path,
          ["--git-dir", owner.common, "worktree", "list", "--porcelain", "-z"],
          AbortSignal.timeout(10000),
        ),
      );
      if (!records.length || records.some((r) => !isAbsolute(r.path)))
        throw new Error("incomplete native listing");
      for (const r of records.slice(1)) {
        const path = (await inventoryPath(resolve(r.path), mounts)) ?? r.path;
        const group = native.get(path) ?? [];
        group.push({ ...r, path });
        native.set(path, group);
      }
      listed = true;
    } catch {
      issue("native-list-unavailable");
    }
  } else issue("native-list-withheld");
  let origin: string | undefined;
  if (slots.some((s) => statuses.rows.has(s.path)))
    origin = githubOrigin(
      await inventoryGit(
        owner.path,
        ["--git-dir", owner.common, "remote", "get-url", "origin"],
        AbortSignal.timeout(5000),
      ).catch(() => ""),
    );
  for (const s of slots) seenPaths.set(s.path, (seenPaths.get(s.path) ?? 0) + 1);
  for (const slot of slots) {
    const { path, admin, checkout } = slot,
      records = native.get(path);
    const nativeRecord = records?.length === 1 ? records[0] : undefined;
    const reciprocalPointer = await reciprocal(slot, mounts);
    const r =
      nativeRecord ??
      (!listed && reciprocalPointer ? await adminRecord(owner, slot, mounts) : undefined);
    const lock = r ? { known: true, reason: r.locked } : await lockFor(slot, mounts);
    const item: Registration = {
      path,
      scope: scope(path, owner.path, roots),
      presence: "withheld",
      source: nativeRecord ? "git-porcelain" : "admin-backlink",
      nativeListed: listed ? !!nativeRecord : null,
      locked: lock.known ? lock.reason !== undefined : null,
      prunable: nativeRecord
        ? nativeRecord.prunable !== undefined
        : lock.reason !== undefined
          ? false
          : null,
      ...lifecycleEvidence(statuses, path, r),
      finishedEvidence: finishedEvidence(statuses, path, reciprocalPointer ? r : undefined),
      nativeReview: nativeReview(statuses, path),
    };
    if (seenPaths.get(path) === 1) {
      if (checkout.status === "missing") item.presence = "missing";
      else if (checkout.stats?.isDirectory()) {
        item.presence = reciprocalPointer && r ? "reciprocal" : "present-unverified";
        if (item.presence === "reciprocal" && r)
          item.nativeReview = await review(slot, owner, roots, mounts, statuses, r, origin);
      }
    }
    if (item.presence === "missing") {
      const kind = item.locked
        ? "admin-locked"
        : item.prunable
          ? "admin-prunable"
          : item.prunable === false
            ? "admin-other"
            : "admin-unverified";
      const direct = await mapDirectStorageEntries(
        admin,
        mounts,
        budget,
        ({ stats }) => (stats.isFile() ? gitFileObservation(kind, stats) : null),
        { expected: slot.stats },
      );
      const totals = new GitNameTotals();
      for (const file of direct.entries) {
        if (file) {
          totals.observe(file);
          ledger.observe(file);
        }
      }
      item.missingAdmin = {
        coverage: direct.coverage,
        excluded: direct.excluded,
        directNames: totals.report(),
      };
      if (direct.coverage !== "direct-complete" || direct.excluded) issue("missing-admin-partial");
    }
    if (item.presence === "withheld" || item.presence === "present-unverified")
      issue("checkout-unverified");
    entries.push(item);
  }
  for (const [path, records] of native) {
    if (seenPaths.has(path)) continue;
    const r = records.length === 1 ? records[0] : undefined;
    entries.push({
      path,
      scope: scope(path, owner.path, roots),
      presence: "withheld",
      source: "git-porcelain",
      nativeListed: true,
      prunable: r ? r.prunable !== undefined : null,
      locked: r ? r.locked !== undefined : null,
      ...lifecycleEvidence(statuses, path, r),
      finishedEvidence: finishedEvidence(statuses, path),
      nativeReview: "retain",
    });
    issue("unmatched-native-record");
  }
  return {
    coverage:
      scan.coverage !== "direct-complete"
        ? scan.coverage
        : Object.keys(reasons).length
          ? "partial"
          : "complete",
    entries,
    reasons,
  };
}
