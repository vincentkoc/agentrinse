import type { BigIntStats } from "node:fs";

export const crabboxStagingRule = {
  id: "crabbox.staging",
  owner: "Crabbox",
  inventory: "storage --rule crabbox.staging --measure",
  requires:
    "The native staging inspector verifies last use, leases, live holders and retirement. Directory modification time is only a review hint.",
};

export const prDependenciesRule = {
  id: "openclaw.pr-dependencies",
  owner: "OpenClaw PR tooling",
  inventory: "storage --rule openclaw.pr-dependencies --measure",
  requires:
    "OpenClaw owns installations, stages, donors and lifetime holds. A directory older than 48 hours can still serve a live PR lane.",
};

export const laneCacheRules = [crabboxStagingRule, prDependenciesRule];
export const reviewAgeMs = 48 * 60 * 60 * 1000;

export function directoryMtimeReview(stats: BigIntStats, now: number) {
  const age = BigInt(now) * 1_000_000n - stats.mtimeNs;
  if (age < 0n || stats.mtimeNs <= 0n) return "unknown";
  return age > BigInt(reviewAgeMs) * 1_000_000n ? "older-than-48-hours" : "within-48-hours";
}
