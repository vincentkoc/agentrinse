import { isProviderEnabled } from "../adapters/provider-specs.js";
import { artifactNames } from "../rules/builtin.generated.js";
import { fileRules } from "../rules/file-rule.js";
import { storageLocations } from "../rules/storage/catalog.js";
import { defaultReviewAgeMinutes, laneCacheRules } from "../rules/openclaw/lane-caches.js";
import { artifactPolicy, providerFilePolicy, storageFamilies } from "./rule-options.js";
import type { AgentRinseConfig } from "./schema.js";

export function policyCatalog(config: AgentRinseConfig) {
  return {
    schemaVersion: 1,
    worktrees: {
      enabled: config.worktrees.enabled ?? true,
      minAgeMinutes: config.worktrees.minAgeMinutes,
      quarantineTtlMinutes: config.worktrees.quarantineTtlMinutes,
    },
    codexVacuum: {
      enabled: config.codexVacuum?.enabled ?? true,
      requires: "--allow-offline-vacuum and experimental risk",
    },
    providerRules: fileRules.map((rule) => ({
      id: rule.id,
      provider: rule.provider,
      adapterEnabled: isProviderEnabled(config, rule.provider),
      pointer: "/providerRules/" + rule.id,
      floor: { minAgeMinutes: rule.minAgeMinutes, quarantineTtlMinutes: rule.quarantineTtlMinutes },
      effective: providerFilePolicy(rule, config.providerRules),
    })),
    artifacts: artifactNames.map((name) => ({
      name,
      pointer: "/artifacts/byName/" + name,
      effective: artifactPolicy(config.artifacts, name),
    })),
    storage: {
      effect: "inventory-only",
      configured: config.storage ?? {},
      families: storageFamilies,
      rules: [
        ...storageLocations.map(({ id, platform }) => ({ id, platform: platform ?? "all" })),
        ...laneCacheRules.map(({ id }) => ({
          id,
          platform: "all",
          reviewAgeMinutes: config.storage?.reviewAgeMinutes?.[id] ?? defaultReviewAgeMinutes,
          defaultReviewAgeMinutes,
        })),
      ],
    },
  };
}
