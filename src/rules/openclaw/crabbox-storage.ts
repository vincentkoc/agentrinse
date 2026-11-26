import { createHash } from "node:crypto";
import { join, parse } from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { measureCacheTree } from "../../core/storage-measurement.js";
import { openPinnedProviderFile } from "../../core/pinned-file.js";
import {
  directStorageEntries,
  observeStoragePath,
  sameObservation,
  type DirectEntry,
  type EntryBudget,
} from "../../core/storage-observation.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";

import { currentStagingIdentity, directoryIdentity } from "./crabbox-identity.js";

const prefix = "openclaw-crabbox-sync-";
const limit = 32 * 1024;
const mirrorReviewAgeMs = 48 * 60 * 60 * 1000;

const receipt = z.object({
  version: z.literal(2),
  id: z.uuid(),
  kind: z.enum(["worktree", "capsule"]),
  ownerPid: z.number().int().min(2),
  rootIdentity: directoryIdentity,
  identityRecordedAtNs: z
    .string()
    .regex(/^[1-9]\d*$/u)
    .optional(),
  payloadIdentity: directoryIdentity,
  durable: z.boolean(),
  repository: z.string(),
  manifest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  users: z.enum(["none", "admitted", "settled"]),
  state: z.enum(["preparing", "prepared", "admitted", "settled", "preserved", "removing"]),
  leases: z.array(z.string()).max(16).optional(),
  hold: z.enum(["artifacts", "claims", "writers", "registration"]).optional(),
  mirror: z
    .object({
      key: z.string().regex(/^[a-f0-9]{64}$/u),
      slotIdentity: directoryIdentity,
      idle: z.boolean(),
      lastUsed: z.number().int().nonnegative(),
      disposing: z.literal(true).optional(),
    })
    .optional(),
});

type ReceiptObservation = {
  classification: string;
  receipt: string;
  fingerprint?: string;
  identityReview?: string;
  state?: string;
  users?: string;
  recordedLeaseCount?: number;
  liveHolders?: "unverified";
  lastUseReview?: "at-least-48-hours" | "under-48-hours";
  idle?: boolean;
  lastUsedMs?: number | null;
};
async function inspectReceipt(
  entry: DirectEntry,
  mounts: StorageMount[],
  now: number,
): Promise<ReceiptObservation> {
  const path = join(entry.path, "staging.json");
  if (coveringMount(path, mounts) !== coveringMount(entry.path, mounts))
    return { classification: "unverified-staging", receipt: "mount-boundary" };
  const observed = await observeStoragePath(path, mounts);
  const before = observed.stats;
  if (
    !before ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.dev !== entry.stats.dev ||
    before.size < 2n ||
    before.size > BigInt(limit) ||
    before.uid !== entry.stats.uid ||
    (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
  )
    return {
      classification: "unverified-staging",
      receipt: observed.status === "missing" ? "absent" : "unavailable",
    };
  try {
    const handle = await openPinnedProviderFile(path, parse(path).root);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        BigInt(stat.dev) !== before.dev ||
        BigInt(stat.ino) !== before.ino ||
        BigInt(stat.size) !== before.size
      )
        throw new Error("changed receipt");
      const buffer = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) throw new Error("short receipt");
        offset += bytesRead;
      }
      const data = receipt.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
      );
      const recorded = data.identityRecordedAtNs
        ? BigInt(data.identityRecordedAtNs)
        : before.mtimeNs;
      const deadline = recorded < before.mtimeNs ? recorded : before.mtimeNs;
      if (!(await currentStagingIdentity(entry, data, mounts, deadline)))
        return {
          classification: "unverified-staging",
          receipt: "current-identity-mismatch",
          identityReview: "producer-stable-identity-required",
        };
      if (
        entry.name !== prefix + data.id ||
        !sameObservation(before, await lstat(path, { bigint: true })) ||
        !sameObservation(entry.stats, await lstat(entry.path, { bigint: true }))
      )
        throw new Error("stale receipt");
      const mirror = data.mirror;
      const validLastUse = mirror && mirror.lastUsed > 0 && mirror.lastUsed <= now;
      const lock = await observeStoragePath(join(entry.path, "recovery.lock"), mounts);
      const reuse =
        mirror?.idle &&
        validLastUse &&
        data.durable &&
        data.manifest &&
        lock.status === "missing" &&
        ((data.state === "preserved" && data.users === "settled") ||
          (data.state === "prepared" && data.users === "none")) &&
        !data.hold &&
        !mirror.disposing;
      return {
        classification: reuse
          ? "reported-reusable-mirror"
          : mirror
            ? "reported-mirror"
            : "reported-" + data.kind,
        receipt: "v2-observation",
        fingerprint: createHash("sha256").update(buffer).digest("hex"),
        state: data.state,
        users: data.users,
        recordedLeaseCount: data.leases?.length ?? 0,
        liveHolders: "unverified",
        ...(reuse
          ? {
              lastUseReview:
                now - mirror!.lastUsed >= mirrorReviewAgeMs
                  ? "at-least-48-hours"
                  : "under-48-hours",
            }
          : {}),
        ...(mirror ? { idle: mirror.idle, lastUsedMs: validLastUse ? mirror.lastUsed : null } : {}),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { classification: "unverified-staging", receipt: "invalid-or-changed" };
  }
}

export async function collectCrabboxStorage(
  root: string,
  mounts: StorageMount[] | undefined,
  budget: EntryBudget,
  now: number,
  receiptBudget: EntryBudget,
  measure = false,
  measureTree = measureCacheTree,
) {
  const scan = await directStorageEntries(root, mounts, budget);
  const entries = [];
  let otherEntries = 0,
    mirrorIndex = false,
    receiptsOmitted = 0,
    unverifiedEntries = 0;
  for (const entry of scan.entries) {
    if (entry.name === "mirrors" && entry.stats.isDirectory()) {
      mirrorIndex = true;
      continue;
    }
    if (!entry.stats.isDirectory() || !entry.name.startsWith(prefix)) {
      otherEntries++;
      continue;
    }
    const id = entry.name.slice(prefix.length);
    const validId = z.uuid().safeParse(id).success;
    if (validId && !receiptBudget.remaining) {
      receiptsOmitted++;
      continue;
    }
    if (validId) receiptBudget.remaining--;
    let observation: ReceiptObservation = validId
      ? await inspectReceipt(entry, mounts!, now)
      : { classification: "legacy-or-unidentified", receipt: "uninspected" };
    let measurement;
    if (measure && observation.fingerprint) {
      measurement = await measureTree(entry.path, entry.stats, mounts!, budget);
      const after = await inspectReceipt(entry, mounts!, now);
      if (after.fingerprint !== observation.fingerprint) {
        observation = {
          classification: "unverified-staging",
          receipt: "changed-during-measurement",
        };
        measurement = undefined;
      } else {
        observation = after;
      }
    }
    if (!observation.fingerprint) unverifiedEntries++;
    const { fingerprint: _, ...evidence } = observation;
    entries.push({
      path: entry.path,
      ...evidence,
      ...(measure
        ? { measurement: measurement ?? { extent: "unknown", reason: "unverified-receipt" } }
        : {}),
    });
  }
  return {
    root,
    coverage:
      scan.coverage === "direct-complete" && (scan.excluded || unverifiedEntries || receiptsOmitted)
        ? "direct-partial"
        : scan.coverage,
    entries,
    mirrorIndex,
    otherEntries,
    receiptsOmitted,
    unverifiedEntries,
    excluded: scan.excluded,
    reclaimableBytes: null,
  };
}
