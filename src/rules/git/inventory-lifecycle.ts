import type { BigIntStats } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  lifecycleFor,
  ownerSignoffFor,
  legacyGwtStatus,
  readGwtInput,
  type GwtStatus,
  type Lifecycle,
} from "../../commands/worktree-lifecycle.js";
import type { GitWorktreeRecord } from "../../adapters/git/porcelain.js";
import { isPathInside } from "../../core/safety.js";

const count = z.number().int().nonnegative().nullable();
const path = z.string().refine(isAbsolute);
const id = z
  .object({ path, dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) })
  .nullable();
const identity = z.object({
  root: path,
  repo: z.string(),
  checkout: id,
  admin: id,
  common: id,
  owner: id,
});
const projected = z.object({
  worktree: path,
  state: z.string(),
  checkout: z.string(),
  retirement_state: z.string(),
  generation: count,
  finish_head: z.string().nullable(),
  cancellation_head: z.string().nullable(),
  branch: z.string().nullable(),
  lock_reason: z.string().nullable(),
  pin_count: count,
  has_intent: z.boolean().nullable(),
  has_result: z.boolean().nullable(),
  owner_count: count,
  completed_count: count,
  released_count: count,
  cancelled_count: count,
  owner_signoff: z.enum(["released", "cancelled", "pending", "report-only", "unknown"]),
  identity: z.unknown(),
});
const envelope = z.object({
  schema: z.literal("gwt-finish-inventory.v1"),
  source: z.literal("gwt finish-status --all --read-only --inventory-json"),
  records: z.array(projected).max(100000),
});
type Row = z.infer<typeof projected>;
export type GitLifecycleInput = {
  mode: "not-supplied" | "legacy-signoff-only" | "inventory-v1";
  legacy: Map<string, GwtStatus[]>;
  rows: Map<string, Row[]>;
};
export async function gitLifecycleInput(
  input?: AsyncIterable<Uint8Array>,
): Promise<GitLifecycleInput> {
  const result: GitLifecycleInput = { mode: "not-supplied", legacy: new Map(), rows: new Map() };
  if (!input) return result;
  const value = await readGwtInput(input);
  if (Array.isArray(value)) {
    result.mode = "legacy-signoff-only";
    result.legacy = legacyGwtStatus(value);
    return result;
  }
  const parsed = envelope.safeParse(value);
  if (!parsed.success)
    throw new Error("Expected a gwt-finish-inventory.v1 envelope or a native finish-status array");
  result.mode = "inventory-v1";
  for (const row of parsed.data.records) {
    const group = result.rows.get(row.worktree) ?? [];
    group.push(row);
    result.rows.set(row.worktree, group);
  }
  return result;
}
export type CurrentRegistration = {
  owner: string;
  common: string;
  admin: string;
  repo: string | undefined;
  record: GitWorktreeRecord;
  roots: string[];
  checkoutStats: BigIntStats;
  adminStats: BigIntStats;
  commonStats: BigIntStats;
  ownerStats: BigIntStats;
};
function sameId(stats: BigIntStats, path: string, proof: z.infer<typeof id>) {
  return (
    proof !== null &&
    proof.path === path &&
    typeof process.geteuid === "function" &&
    stats.uid === BigInt(process.geteuid()) &&
    stats.isDirectory() &&
    stats.dev.toString() === proof.dev &&
    stats.ino.toString() === proof.ino &&
    stats.ino > 0n
  );
}
export function lifecycleEvidence(
  input: GitLifecycleInput,
  path: string,
  record?: GitWorktreeRecord,
) {
  const group = input.rows.get(path);
  if (!group) {
    const old = input.legacy.get(path);
    return {
      lifecycle: lifecycleFor(old, record?.head),
      ownerSignoff: ownerSignoffFor(old, record?.head),
    };
  }
  const row = group.length === 1 ? group[0] : undefined;
  let lifecycle: Lifecycle = "unresolved";
  if (row && row.pin_count !== null) {
    if (row.pin_count) lifecycle = "pinned";
    else if (row.checkout === "removed") lifecycle = "removed";
    else if (
      row.checkout === "retained" &&
      ["enrolled", "report-only"].includes(row.retirement_state) &&
      (row.state === "finished" || row.state === "cancelled" || row.state === "active")
    )
      lifecycle = row.state;
  }
  return { lifecycle, ownerSignoff: row?.owner_signoff ?? "unknown" };
}
export function finishedEvidence(input: GitLifecycleInput, path: string, r?: GitWorktreeRecord) {
  if (input.mode !== "inventory-v1") return null;
  const group = input.rows.get(path),
    row = group?.length === 1 ? group[0] : undefined;
  const signedHead =
    !!r?.head &&
    !!row &&
    row.state === "finished" &&
    row.checkout === "retained" &&
    row.owner_signoff === "released" &&
    !!row.owner_count &&
    row.owner_count === row.completed_count &&
    row.owner_count === row.released_count &&
    row.finish_head === r.head;
  const enrolledLock =
    signedHead &&
    row.retirement_state === "enrolled" &&
    row.pin_count === 0 &&
    !!row.lock_reason &&
    row.lock_reason === r.locked &&
    /^gwt-finish\.v2:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(row.lock_reason);
  return { signedHead, enrolledLock };
}
export function nativeReview(input: GitLifecycleInput, path: string, now?: CurrentRegistration) {
  if (input.mode === "not-supplied") return "not-supplied";
  if (input.mode === "legacy-signoff-only")
    return input.legacy.has(path) ? "unverified-signoff" : "unreported";
  const rows = input.rows.get(path);
  if (!rows) return "unreported";
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    !row ||
    row.checkout !== "retained" ||
    row.retirement_state !== "enrolled" ||
    row.pin_count !== 0 ||
    row.has_intent !== false ||
    row.has_result !== false ||
    !row.generation ||
    !row.owner_count ||
    !now
  )
    return "retain";
  const finished =
    row.state === "finished" &&
    row.owner_signoff === "released" &&
    row.owner_count === row.completed_count &&
    row.owner_count === row.released_count;
  const cancelled =
    row.state === "cancelled" && row.owner_signoff === "cancelled" && !!row.cancelled_count;
  if (!finished && !cancelled) return "retain";
  const expectedHead = finished ? row.finish_head : row.cancellation_head;
  if (!expectedHead || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(expectedHead))
    return "unverified-signoff";
  if (now.record.head !== expectedHead) return "finish-head-mismatch";
  const proof = identity.safeParse(row.identity);
  if (!proof.success) return "unverified-signoff";
  const i = proof.data;
  if (
    !now.roots.includes(i.root) ||
    !isPathInside(i.root, path) ||
    path === i.root ||
    isPathInside(i.root, now.owner) ||
    i.repo !== now.repo ||
    !row.branch?.startsWith("refs/heads/") ||
    row.branch !== now.record.branch ||
    now.record.prunable !== undefined ||
    row.lock_reason !== now.record.locked ||
    !/^gwt-finish\.v2:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(row.lock_reason ?? "")
  )
    return "binding-mismatch";
  if (
    !sameId(now.checkoutStats, path, i.checkout) ||
    !sameId(now.ownerStats, now.owner, i.owner) ||
    !sameId(now.commonStats, now.common, i.common) ||
    !sameId(now.adminStats, now.admin, i.admin)
  )
    return "identity-mismatch";
  return "review-native-closeout";
}
