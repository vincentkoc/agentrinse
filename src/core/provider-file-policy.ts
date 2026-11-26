import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveProviderRoot } from "../adapters/provider-root.js";
import { hasOpenClawJournal } from "../adapters/openclaw-database.js";
import { isProviderEnabled, PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ProviderFileQuarantineAction } from "../contracts/action.js";
import { matchProviderFilePolicy, type ProviderFileRule } from "../rules/file-rule.js";

export type ProviderFileOwnerRootOptions = {
  root?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
};

export function resolveProviderFileOwnerRoot(
  policy: ProviderFileRule,
  home: string,
  options: ProviderFileOwnerRootOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const providerRoot = resolveProviderRoot(PROVIDER_SPECS[policy.provider], resolve(home), {
    ...(options.root === undefined ? {} : { root: options.root }),
    platform,
    environment: options.environment ?? process.env,
  });
  if (policy.ownerRoot === "provider-root") {
    return providerRoot;
  }
  if (policy.provider !== "zed") {
    throw new Error(`unsupported provider-file owner-root contract: ${policy.provider}`);
  }
  return options.root === undefined && platform === "darwin"
    ? resolve(home, "Library", "Logs", "Zed")
    : join(providerRoot, "logs");
}

export async function authorizeProviderFileAction(
  action: ProviderFileQuarantineAction,
  home: string,
  config: AgentRinseConfig,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<void> {
  const explicitRoot = config.adapters[action.adapter]?.root;
  if (action.adapter === "openclaw" && config.adapters.openclaw?.enabled !== true) {
    throw new Error("OpenClaw snapshot quarantine requires the OpenClaw adapter to be enabled");
  }
  if (!isProviderEnabled(config, action.adapter)) {
    throw new Error(
      "Provider-file quarantine requires the " + action.adapter + " adapter to be enabled",
    );
  }
  const policy = matchProviderFilePolicy(
    action.adapter,
    action.policyId,
    action.target.relativePath,
  );
  if (policy === undefined) {
    throw new Error(
      `provider-file target is not approved by policy ${action.adapter}:${action.policyId}`,
    );
  }
  const configuredRoot = resolveProviderFileOwnerRoot(policy, home, {
    ...(explicitRoot === undefined ? {} : { root: explicitRoot }),
    platform,
    environment,
  });
  const physicalRoot = await realpath(configuredRoot);
  if (
    action.adapter === "openclaw" &&
    (!(await lstat(configuredRoot)).isDirectory() ||
      (await hasOpenClawJournal(join(physicalRoot, "state", "openclaw.sqlite"))))
  ) {
    throw new Error("OpenClaw profile changed or its shared database has a pending journal");
  }
  if (action.target.ownerRoot !== physicalRoot) {
    throw new Error(`provider-file target is outside the configured ${action.adapter} root`);
  }
  const refusal = validateRecoveryWindow(action, policy, now);
  if (refusal !== undefined) {
    throw new Error(
      `provider-file action violates policy ${action.adapter}:${action.policyId}: ${refusal}`,
    );
  }
}

function validateRecoveryWindow(
  action: ProviderFileQuarantineAction,
  rule: ProviderFileRule,
  now: Date,
): string | undefined {
  if (action.pendingQuarantineBytes !== action.target.measuredBytes) {
    return "pending quarantine bytes must match the exact file identity";
  }
  if (action.quarantineTtlMinutes < rule.quarantineDays * 1440) {
    const days = rule.quarantineDays === 7 ? "seven" : rule.quarantineDays;
    return `${rule.subject} require at least ${days} days of recoverable quarantine`;
  }
  if (now.getTime() - action.target.mtimeMs < rule.minAgeDays * 86_400_000) {
    return `${rule.subject} must be at least ${rule.minAgeDays} days old`;
  }
}
