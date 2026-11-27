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
export const defaultReviewAgeMinutes = 48 * 60;
export const reviewAgeMs = defaultReviewAgeMinutes * 60_000;
export function lastUseReview(now: number, lastUse: number, minutes: number) {
  const reached = now - lastUse >= minutes * 60_000;
  if (minutes === defaultReviewAgeMinutes) return reached ? "at-least-48-hours" : "under-48-hours";
  return reached ? "at-least-configured-age" : "under-configured-age";
}

export function directoryMtimeReview(
  stats: BigIntStats,
  now: number,
  minutes = defaultReviewAgeMinutes,
) {
  const age = BigInt(now) * 1_000_000n - stats.mtimeNs;
  if (age < 0n || stats.mtimeNs <= 0n) return "unknown";
  const older = age > BigInt(minutes) * 60_000_000_000n;
  if (minutes === defaultReviewAgeMinutes) return older ? "older-than-48-hours" : "within-48-hours";
  return older ? "older-than-configured-age" : "within-configured-age";
}
