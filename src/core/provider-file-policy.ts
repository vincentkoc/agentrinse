import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ProviderFileQuarantineAction, ProviderMutationId } from "../contracts/action.js";

export type ProviderFilePolicy = {
  id: string;
  provider: ProviderMutationId;
  matchesRelativePath(relativePath: string): boolean;
};

// Provider PRs add narrowly documented file contracts here. An empty registry
// deliberately makes the shared executor unusable on its own.
export const PROVIDER_FILE_POLICIES: readonly ProviderFilePolicy[] = [];

export async function authorizeProviderFileAction(
  action: ProviderFileQuarantineAction,
  home: string,
  config: AgentRinseConfig,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const configuredRoot =
    config.adapters[action.adapter]?.root ??
    PROVIDER_SPECS[action.adapter].defaultRoot(resolve(home), platform);
  const physicalRoot = await realpath(resolve(configuredRoot));
  if (action.target.ownerRoot !== physicalRoot) {
    throw new Error(`provider-file target is outside the configured ${action.adapter} root`);
  }
  const policy = PROVIDER_FILE_POLICIES.find(
    (candidate) => candidate.id === action.policyId && candidate.provider === action.adapter,
  );
  if (policy === undefined || !policy.matchesRelativePath(action.target.relativePath)) {
    throw new Error(
      `provider-file target is not approved by policy ${action.adapter}:${action.policyId}`,
    );
  }
}
