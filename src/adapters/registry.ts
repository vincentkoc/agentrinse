import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter } from "../contracts/adapter.js";
import { sha256 } from "../core/digest.js";
import { ReachabilityIndex, type ReachabilityRoot } from "../core/reachability.js";
import { ArtifactAuditAdapter } from "./artifacts/adapter.js";
import { DockerAuditAdapter } from "./docker/adapter.js";
import { GitWorktreeAuditAdapter } from "./git/adapter.js";
import { ProviderAuditAdapter } from "./provider-adapter.js";
import { PROVIDER_IDS, PROVIDER_SPECS, type ProviderAdapterId } from "./provider-specs.js";
import { RuntimeAuditAdapter } from "./runtime/adapter.js";

const PROVIDER_ID_SET = new Set<string>(PROVIDER_IDS);

export type AuditAdapterRegistryOptions = {
  providers?: readonly ProviderAdapterId[];
  providerInventory?: boolean;
  roots?: ReachabilityRoot[];
  environment?: NodeJS.ProcessEnv;
  reachability?: ReachabilityIndex;
  allowOfflineVacuum?: boolean;
};

function validateProviderSelection(providers: readonly ProviderAdapterId[]): ProviderAdapterId[] {
  if (providers.length === 0) {
    throw new Error("provider selection must not be empty");
  }
  const selected: ProviderAdapterId[] = [];
  const seen = new Set<string>();
  for (const id of providers) {
    if (!PROVIDER_ID_SET.has(id)) {
      throw new Error(`unknown provider ID: ${String(id)}`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate provider ID: ${id}`);
    }
    seen.add(id);
    selected.push(id);
  }
  return selected;
}

export function createAuditAdapters(
  config: AgentRinseConfig,
  platform: NodeJS.Platform = process.platform,
  options: AuditAdapterRegistryOptions = {},
): AuditAdapter[] {
  const reachability = options.reachability ?? new ReachabilityIndex();
  const providerSelection =
    options.providers === undefined ? undefined : validateProviderSelection(options.providers);
  const exclusiveProviders = providerSelection !== undefined;
  const gitEnabled = !exclusiveProviders && config.adapters.git?.enabled === true;
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
  const providerIds =
    providerSelection ?? PROVIDER_IDS.filter((id) => config.adapters[id]?.enabled !== false);
  const adapters: AuditAdapter[] = providerIds.map(
    (id) =>
      new ProviderAuditAdapter(PROVIDER_SPECS[id], {
        ...(config.adapters[id]?.root === undefined ? {} : { root: config.adapters[id].root }),
        platform,
        measureBytes: config.audit.measureBytes,
        maxEntries: config.audit.maxEntries,
        reachability,
        inventoryResources: options.providerInventory ?? true,
        allowOfflineVacuum: options.allowOfflineVacuum ?? false,
        environment: options.environment ?? process.env,
      }),
  );

  if (exclusiveProviders) {
    return adapters;
  }

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
    const environment = options.environment ?? process.env;
    const builderOverride = environment["BUILDX_BUILDER"]?.trim() || undefined;
    adapters.push(
      new DockerAuditAdapter(undefined, {
        builderOverride,
        environment,
      }),
    );
  }

  return adapters;
}
