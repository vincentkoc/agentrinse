import type { RootEvidence } from "../../contracts/finding.js";
import {
  dockerBuildCacheIsOldEnough,
  type DockerBuildCacheRecord,
} from "../../adapters/docker/owner.js";

export function estimatedCacheReclaimBytes(cache: DockerBuildCacheRecord): number | undefined {
  if (cache.sizeEvidence.kind !== "exact") return undefined;
  return cache.reclaimable && !cache.shared ? cache.sizeEvidence.bytes : 0;
}

export function buildCacheProtection(
  cache: DockerBuildCacheRecord,
  now: Date,
): Pick<RootEvidence, "code" | "detail"> {
  if (cache.mutable) {
    return {
      code: "docker-build-cache-mutable",
      detail: "Docker reports this build-cache record as mutable.",
    };
  }
  if (!cache.reclaimable) {
    return {
      code: "docker-build-cache-in-use",
      detail: "Docker reports this build-cache record as not reclaimable.",
    };
  }
  if (cache.recordType === undefined) {
    return {
      code: "docker-build-cache-type-unknown",
      detail: "Buildx did not expose this cache record's type.",
    };
  }
  if (cache.recordType === "internal" || cache.recordType === "frontend") {
    return {
      code: "docker-build-cache-internal",
      detail: `Docker classifies this as ${cache.recordType} build cache.`,
    };
  }
  if (!dockerBuildCacheIsOldEnough(cache, now)) {
    return {
      code: "docker-build-cache-recent",
      detail: "The cache record lacks conservative proof that it is at least seven days old.",
    };
  }
  return {
    code: "docker-build-cache-mutation-unbound",
    detail:
      "Buildx prune re-resolves context and builder names and cannot condition deletion on the revalidated daemon and worker identity.",
  };
}
