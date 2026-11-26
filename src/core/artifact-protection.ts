import { dirname } from "node:path";
import { matchingGitRefPins } from "../adapters/git/refs.js";
import { findArtifactGitRepository, runArtifactGit } from "./artifact-git-state.js";
import { createAuditAdapters } from "../adapters/registry.js";
import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ArtifactRemoveAction } from "../contracts/action.js";
import type { RootEvidence } from "../contracts/finding.js";
import { ReachabilityIndex } from "./reachability.js";

async function bindArtifactGitRefPins(
  reachability: ReachabilityIndex,
  project: string,
  observedAt: string,
): Promise<void> {
  const pins = reachability.activeGitRefs(observedAt);
  if (pins.length === 0) return;
  // Ancestor worktrees can protect nested repositories too. Inspect only owners of this project.
  let directory = project;
  while (true) {
    const root = await findArtifactGitRepository(directory);
    if (!root) return;
    const run = (args: string[]) => runArtifactGit(root, args);
    const head = (await run(["rev-parse", "--verify", "HEAD"])).trim();
    const branch = (await run(["rev-parse", "--symbolic-full-name", "HEAD"])).trim();
    const refs = await matchingGitRefPins(run, head, pins, { requireCompleteHistory: true });
    if (branch.startsWith("refs/heads/")) {
      refs.push(branch, (await run(["for-each-ref", "--format=%(upstream)", "--", branch])).trim());
    }
    reachability.bindGitRefsToPath(root, refs, observedAt);
    const parent = dirname(root);
    if (parent === root) return;
    directory = parent;
  }
}

export async function currentArtifactProtectionRoots(
  action: ArtifactRemoveAction,
  home: string,
  config: AgentRinseConfig,
  now: Date,
): Promise<RootEvidence[]> {
  const reachability = new ReachabilityIndex();
  const adapters = createAuditAdapters(config, process.platform, {
    providerInventory: false,
    reachability,
  }).filter((adapter) => Object.hasOwn(PROVIDER_SPECS, adapter.id));
  const context = { home, now, auditId: `apply-${action.actionId}` };

  for (const adapter of adapters) {
    const probe = await adapter.probe(context);
    await adapter.collect(context, probe);
  }

  const observedAt = now.toISOString();
  await bindArtifactGitRefPins(reachability, action.target.projectRoot, observedAt);
  return reachability.rootsForResource(
    {
      id: action.resourceId,
      adapter: action.adapter,
      kind: "build-artifact",
      canonicalKey: action.target.path,
      displayName: action.target.name,
      path: action.target.path,
    },
    {},
    observedAt,
  );
}
