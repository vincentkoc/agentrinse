import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter } from "../contracts/adapter.js";
import { sha256 } from "../core/digest.js";
import { ReachabilityIndex, type ReachabilityRoot } from "../core/reachability.js";
import { ArtifactAuditAdapter } from "./artifacts/adapter.js";
import { DockerAuditAdapter } from "./docker/adapter.js";
import { GitWorktreeAuditAdapter } from "./git/adapter.js";
import { ProviderAuditAdapter } from "./provider-adapter.js";
import { PROVIDER_SPECS, type ProviderAdapterId } from "./provider-specs.js";
import { RuntimeAuditAdapter } from "./runtime/adapter.js";

const PROVIDER_IDS = Object.keys(PROVIDER_SPECS) as ProviderAdapterId[];

export type AuditAdapterRegistryOptions = {
  providerInventory?: boolean;
  roots?: ReachabilityRoot[];
  environment?: NodeJS.ProcessEnv;
  reachability?: ReachabilityIndex;
  allowOfflineVacuum?: boolean;
};

export function createAuditAdapters(
  config: AgentRinseConfig,
  platform: NodeJS.Platform = process.platform,
  options: AuditAdapterRegistryOptions = {},
): AuditAdapter[] {
  const reachability = options.reachability ?? new ReachabilityIndex();
  const gitEnabled = config.adapters.git?.enabled === true;
  for (const root of options.roots ?? []) {
    reachability.add(root);
  }
  for (const pin of config.pins) {
    const root = {
      code: "user-pin",
      source: "config",
      detail: "User configuration pins this resource.",
      evidenceRef: sha256(JSON.stringify(pin)),
      ...(pin.expiresAt === undefined ? {} : { expiresAt: pin.expiresAt }),
    };
    if ("path" in pin) {
      reachability.add({ ...root, path: pin.path });
    } else if ("resourceId" in pin) {
      reachability.addResource(pin.resourceId, root);
    } else if (gitEnabled) {
      reachability.addGitRef(pin.gitRef, root);
    } else {
      reachability.addGlobal({
        ...root,
        detail: "Git ref pin resolution requires the Git adapter.",
      });
    }
  }
  const adapters: AuditAdapter[] = PROVIDER_IDS.filter(
    (id) => config.adapters[id]?.enabled !== false,
  ).map(
    (id) =>
      new ProviderAuditAdapter(PROVIDER_SPECS[id], {
        ...(config.adapters[id]?.root === undefined ? {} : { root: config.adapters[id].root }),
        platform,
        measureBytes: config.audit.measureBytes,
        maxEntries: config.audit.maxEntries,
        reachability,
        inventoryResources: options.providerInventory ?? true,
        allowOfflineVacuum: options.allowOfflineVacuum ?? false,
      }),
  );

  if (gitEnabled) {
    adapters.push(
      new GitWorktreeAuditAdapter(
        config.adapters.git?.root,
        undefined,
        undefined,
        undefined,
        reachability,
        {
          ...config.audit,
          ...config.worktrees,
          platform,
        },
      ),
    );
  }

  if (config.artifacts.projects.length > 0) {
    adapters.push(
      new ArtifactAuditAdapter(
        {
          ...config.artifacts,
          ...config.audit,
        },
        undefined,
        undefined,
        reachability,
      ),
    );
  }

  if (config.adapters.runtime?.enabled !== false) {
    adapters.push(
      new RuntimeAuditAdapter({
        platform,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }),
    );
  }

  if (config.adapters.docker?.enabled === true) {
    adapters.push(new DockerAuditAdapter());
  }

  return adapters;
}
