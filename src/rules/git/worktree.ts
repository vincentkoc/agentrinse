import { basename } from "node:path";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import type { RootEvidence } from "../../contracts/finding.js";
import type { ReachabilityIndex } from "../../core/reachability.js";
import { registrationProtections } from "./registration.js";

export function worktreeProtectionRoots(
  resource: ResourceSnapshot,
  observedAt: string,
  minAgeMinutes: number,
  reachability?: ReachabilityIndex,
): RootEvidence[] {
  const facts = resource.facts;
  const roots: RootEvidence[] = registrationProtections({
    isMain: facts.isMain === true,
    platform: String(facts.platform),
    bare: facts.bare === true,
    prunable: facts.prunable,
    locked: facts.locked,
  }).map(({ code, detail }) => ({ code, source: "git", observedAt, detail }));

  function protect(code: string, detail: string, source = "git") {
    roots.push({ code, source, observedAt, detail });
  }

  if (
    Number(facts.staged ?? 0) +
      Number(facts.modified ?? 0) +
      Number(facts.untracked ?? 0) +
      Number(facts.conflicted ?? 0) >
    0
  ) {
    protect("dirty-worktree", "Git reports staged, modified, conflicted, or untracked work.");
  }
  if (typeof facts.ignored === "number" && facts.ignored > 0) {
    protect(
      "ignored-worktree-content",
      "Git reports ignored content that would be lost by whole-worktree cleanup.",
    );
  }
  if (typeof facts.statusSuppressedEntries === "number" && facts.statusSuppressedEntries > 0) {
    protect(
      "git-status-suppressed",
      "Git index flags suppress status visibility for one or more tracked paths.",
    );
  }
  if (Array.isArray(facts.operations) && facts.operations.length > 0) {
    protect(
      "git-operation-in-progress",
      `Git operation in progress: ${facts.operations.join(", ")}.`,
    );
  }
  if (facts.unpushed === true) {
    protect(
      "unpushed-commit",
      "The worktree HEAD is ahead of or absent from local remote-tracking refs.",
    );
  }
  if (facts.processOwnership === "busy") {
    protect(
      "live-process-worktree",
      "A live process has its CWD or an open file inside this worktree.",
      "process",
    );
  }
  if (facts.processOwnership === "unknown") {
    protect(
      "process-ownership-incomplete",
      "Live process ownership could not be proven completely.",
      "process",
    );
  }
  if (facts.remoteConfigured !== true) {
    protect("unknown-remote", "No configured remote is available for reachability proof.");
  }
  if (facts.detached === true) {
    protect("detached-worktree", "Detached worktrees are outside the 0.3 quarantine boundary.");
  }
  if (
    resource.resource.path !== undefined &&
    basename(resource.resource.path) === ".agentrinse-quarantine"
  ) {
    protect(
      "worktree-quarantine-path-reserved",
      "A worktree cannot use AgentRinse's reserved quarantine container path.",
    );
  }
  if (
    typeof facts.head !== "string" ||
    typeof facts.branch !== "string" ||
    typeof facts.repositoryCommonDir !== "string"
  ) {
    protect(
      "worktree-identity-incomplete",
      "Worktree HEAD, branch, or common Git directory could not be proven.",
    );
  }
  if (facts.hasSubmodules === true) {
    protect(
      "worktree-submodules",
      "Worktrees containing gitlink entries are not quarantine candidates.",
    );
  }
  if (
    resource.measuredBytes === undefined ||
    facts.measurementTruncated === true ||
    typeof facts.fingerprint !== "string"
  ) {
    protect(
      "worktree-measurement-incomplete",
      "Worktree contents could not be measured completely.",
    );
  }
  if (
    (typeof facts.specialEntries === "number" && facts.specialEntries > 0) ||
    (typeof facts.mountBoundaries === "number" && facts.mountBoundaries > 0) ||
    facts.mountBoundaryStatus === "blocked"
  ) {
    protect(
      "worktree-filesystem-boundary",
      "Worktree contents include an unsupported filesystem entry or mount boundary.",
    );
  }
  if (facts.mountBoundaryStatus !== "clear") {
    protect(
      "worktree-mount-inspection-incomplete",
      "Filesystem mount boundaries could not be proven absent.",
    );
  }
  if (typeof facts.ageMinutes !== "number" || facts.ageMinutes < minAgeMinutes) {
    protect("recent-resource", `Worktree is newer than ${minAgeMinutes} minutes.`);
  }
  if (facts.inspectionComplete !== true) {
    protect(
      "git-inspection-incomplete",
      "Git state or reachability could not be proven completely.",
    );
  }
  roots.push(
    ...(reachability?.rootsForResource(resource.resource, resource.facts, observedAt) ?? []),
  );
  if (facts.processOwnershipDeferred === true && roots.length === 0) {
    protect(
      "process-ownership-deferred",
      "Process ownership was deferred for a supposedly protected worktree, but no protection root remained.",
      "process",
    );
  }
  return roots.sort((left, right) => left.code.localeCompare(right.code));
}
