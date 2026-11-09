import { createAuditAdapters } from "../adapters/registry.js";
import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ArtifactRemoveAction } from "../contracts/action.js";
import type { RootEvidence } from "../contracts/finding.js";
import { ReachabilityIndex } from "./reachability.js";

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

  // Artifact actions have no Git ref facts, so unresolved ref pins must protect them.
  const observedAt = now.toISOString();
  reachability.protectUnresolvedGitRefs(observedAt);
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
