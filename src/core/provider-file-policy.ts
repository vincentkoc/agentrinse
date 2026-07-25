import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveProviderRoot } from "../adapters/provider-root.js";
import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ProviderFileQuarantineAction, ProviderMutationId } from "../contracts/action.js";

export type ProviderFilePolicy = {
  id: string;
  provider: ProviderMutationId;
  matchesRelativePath(relativePath: string): boolean;
};

export const CLAUDE_DEBUG_LOG_POLICY_ID = "claude.debug-log";
export const CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES = 30 * 24 * 60;
export const CLAUDE_DEBUG_LOG_QUARANTINE_TTL_MINUTES = 7 * 24 * 60;

export function isClaudeDebugLogRelativePath(relativePath: string): boolean {
  const components = relativePath.split(/[\\/]/u);
  return (
    components.length === 2 &&
    components[0] === "debug" &&
    components[1] !== undefined &&
    components[1].endsWith(".txt")
  );
}

export const PROVIDER_FILE_POLICIES: readonly ProviderFilePolicy[] = [
  {
    id: CLAUDE_DEBUG_LOG_POLICY_ID,
    provider: "claude",
    matchesRelativePath: isClaudeDebugLogRelativePath,
  },
];

export async function authorizeProviderFileAction(
  action: ProviderFileQuarantineAction,
  home: string,
  config: AgentRinseConfig,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const explicitRoot = config.adapters[action.adapter]?.root;
  const configuredRoot = resolveProviderRoot(PROVIDER_SPECS[action.adapter], resolve(home), {
    ...(explicitRoot === undefined ? {} : { root: explicitRoot }),
    platform,
    environment,
  });
  const physicalRoot = await realpath(configuredRoot);
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
