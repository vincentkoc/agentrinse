import { isOpenClawProfileName } from "../rules/openclaw/profile.js";
import type { ArtifactRemoveAction } from "../contracts/action.js";
import type { Measurement } from "./measure.js";

// Exact agent state roots may contain transcripts, credentials, and recovery history.
const agentStateRoots = new Set([
  ".claude",
  ".codex",
  ".copilot",
  ".cursor",
  ".grok",
  ".openclaw",
  ".opencode",
]);

export function isArtifactAgentState(name: string): boolean {
  const key = name.toLowerCase();
  const prefix = ".openclaw-";
  return (
    agentStateRoots.has(key) ||
    (key.startsWith(prefix) && isOpenClawProfileName(name.slice(prefix.length)))
  );
}

// Both before isolation and immediately before removal, prove the measured tree still matches the plan.
export function artifactMeasurementChanged(
  measurement: Measurement,
  target: ArtifactRemoveAction["target"],
): boolean {
  return (
    measurement.truncated ||
    (measurement.protectedEntries ?? 0) > 0 ||
    measurement.bytes !== target.measuredBytes ||
    measurement.newestMtimeMs !== target.newestMtimeMs ||
    measurement.fingerprint !== target.fingerprint ||
    measurement.mountBoundaries > 0 ||
    measurement.vcsMetadataEntries > 0
  );
}
