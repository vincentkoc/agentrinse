import type { Finding } from "../../contracts/finding.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";

type ArtifactBlocker = { code: string; message: string; confidence: Finding["confidence"] };

// Earlier checks determine the reported blocker when multiple observations conflict.
export function artifactInspectionBlocker(
  facts: ResourceSnapshot["facts"],
): ArtifactBlocker | undefined {
  if (facts.isSymlink === true)
    return {
      code: "ARTIFACT_SYMLINK_BLOCKED",
      confidence: "certain",
      message: "Artifact symlinks are never cleanup candidates.",
    };
  if (facts.isDirectory !== true)
    return {
      code: "ARTIFACT_NOT_DIRECTORY",
      confidence: "certain",
      message: "Only declared artifact directories are supported.",
    };
  if (facts.measurementTruncated === true)
    return {
      code: "ARTIFACT_MEASUREMENT_TRUNCATED",
      confidence: "unknown",
      message: "The entry budget was exhausted before measurement completed.",
    };
  if (typeof facts.specialEntries === "number" && facts.specialEntries > 0)
    return {
      code: "ARTIFACT_SPECIAL_ENTRY",
      confidence: "certain",
      message: "Artifact cleanup only supports directories, regular files, and skipped symlinks.",
    };
  if (typeof facts.vcsMetadataEntries === "number" && facts.vcsMetadataEntries > 0)
    return {
      code: "ARTIFACT_NESTED_VCS",
      confidence: "certain",
      message: "Artifact contains nested version-control metadata.",
    };
  if (
    facts.isMountRoot === true ||
    facts.mountBoundaryStatus === "blocked" ||
    (typeof facts.mountBoundaries === "number" && facts.mountBoundaries > 0)
  )
    return {
      code: "ARTIFACT_MOUNT_BOUNDARY",
      confidence: "certain",
      message: "Artifact cleanup never crosses a filesystem mount boundary.",
    };
  if (facts.mountBoundaryStatus !== "clear")
    return {
      code: "ARTIFACT_MOUNT_INSPECTION_UNKNOWN",
      confidence: "unknown",
      message: "Filesystem mount boundaries could not be proven absent.",
    };
  return undefined;
}
