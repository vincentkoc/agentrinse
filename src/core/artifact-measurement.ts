import type { ArtifactRemoveAction } from "../contracts/action.js";
import type { Measurement } from "./measure.js";

// Both before isolation and immediately before removal, prove the measured tree still matches the plan.
export function artifactMeasurementChanged(
  measurement: Measurement,
  target: ArtifactRemoveAction["target"],
): boolean {
  return (
    measurement.truncated ||
    measurement.bytes !== target.measuredBytes ||
    measurement.newestMtimeMs !== target.newestMtimeMs ||
    measurement.fingerprint !== target.fingerprint ||
    measurement.mountBoundaries > 0 ||
    measurement.vcsMetadataEntries > 0
  );
}
