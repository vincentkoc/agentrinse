import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter } from "../contracts/adapter.js";
import { ProviderAuditAdapter } from "./provider-adapter.js";
import { PROVIDER_SPECS, type ProviderAdapterId } from "./provider-specs.js";

const PROVIDER_IDS = Object.keys(PROVIDER_SPECS) as ProviderAdapterId[];

export function createAuditAdapters(
  config: AgentRinseConfig,
  platform: NodeJS.Platform = process.platform,
): AuditAdapter[] {
  return PROVIDER_IDS.filter((id) => config.adapters[id]?.enabled !== false).map(
    (id) =>
      new ProviderAuditAdapter(PROVIDER_SPECS[id], {
        ...(config.adapters[id]?.root === undefined ? {} : { root: config.adapters[id].root }),
        platform,
        measureBytes: config.audit.measureBytes,
        maxEntries: config.audit.maxEntries,
      }),
  );
}
