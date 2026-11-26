import { lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { resolveProviderRoot } from "../adapters/provider-root.js";
import { hasOpenClawJournal } from "../adapters/openclaw-database.js";
import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { ProviderFileQuarantineAction, ProviderMutationId } from "../contracts/action.js";
import type { ResourceKind } from "../contracts/resource.js";

export type ProviderFilePolicy = {
  id: string;
  provider: ProviderMutationId;
  ownerRoot: "provider-root" | "zed-log-root";
  resourceKind: ResourceKind;
  displayName: string;
  minAgeMinutes: number;
  quarantineTtlMinutes: number;
  description: string;
  rootCode: string;
  rootDetail: string;
  tooRecentDetail: string;
  contentPrefix?: string;
  matchesRelativePath(relativePath: string): boolean;
  validateAction(action: ProviderFileQuarantineAction, now: Date): string | undefined;
};

export const CLAUDE_DEBUG_LOG_POLICY_ID = "claude.debug-log";
export const CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES = 30 * 24 * 60;
const CLAUDE_DEBUG_LOG_QUARANTINE_TTL_MINUTES = 7 * 24 * 60;
export const CLAUDE_CHANGELOG_CACHE_POLICY_ID = "claude.changelog-cache";
export const CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES = 30 * 24 * 60;
const CLAUDE_CHANGELOG_CACHE_QUARANTINE_TTL_MINUTES = 7 * 24 * 60;
export const ZED_ROTATED_LOG_POLICY_ID = "zed.rotated-log";
export const ZED_ROTATED_LOG_MIN_AGE_MINUTES = 30 * 24 * 60;
const ZED_ROTATED_LOG_QUARANTINE_TTL_MINUTES = 7 * 24 * 60;

export function isClaudeDebugLogRelativePath(relativePath: string): boolean {
  const components = relativePath.split(sep);
  return (
    components.length === 2 &&
    components[0] === "debug" &&
    components[1] !== undefined &&
    components[1].endsWith(".txt")
  );
}

export function isClaudeChangelogCacheRelativePath(relativePath: string): boolean {
  const components = relativePath.split(sep);
  return components.length === 2 && components[0] === "cache" && components[1] === "changelog.md";
}

export function isZedRotatedLogRelativePath(relativePath: string): boolean {
  const components = relativePath.split(sep);
  return components.length === 1 && components[0] === "Zed.log.old";
}

export type ProviderFileOwnerRootOptions = {
  root?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
};

export function resolveProviderFileOwnerRoot(
  policy: ProviderFilePolicy,
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

function validateAgeAndRecoveryWindow(
  action: ProviderFileQuarantineAction,
  now: Date,
  label: string,
  minimumAgeMinutes: number,
  minimumTtlMinutes: number,
): string | undefined {
  if (action.pendingQuarantineBytes !== action.target.measuredBytes) {
    return "pending quarantine bytes must match the exact file identity";
  }
  if (action.quarantineTtlMinutes < minimumTtlMinutes) {
    return `${label} require at least seven days of recoverable quarantine`;
  }
  if (now.getTime() - action.target.mtimeMs < minimumAgeMinutes * 60_000) {
    return `${label} must be at least 30 days old`;
  }
  return undefined;
}

function fileQuarantinePolicy(
  label: string,
  policy: Omit<ProviderFilePolicy, "validateAction">,
): ProviderFilePolicy {
  return {
    ...policy,
    validateAction(action, now) {
      return validateAgeAndRecoveryWindow(
        action,
        now,
        label,
        policy.minAgeMinutes,
        policy.quarantineTtlMinutes,
      );
    },
  };
}

export const OPENCLAW_SHELL_SNAPSHOT_POLICY = fileQuarantinePolicy("OpenClaw shell snapshots", {
  id: "openclaw.shell-snapshot",
  provider: "openclaw",
  ownerRoot: "provider-root",
  resourceKind: "agent-cache",
  displayName: "OpenClaw generated shell snapshot",
  minAgeMinutes: 30 * 24 * 60,
  quarantineTtlMinutes: 7 * 24 * 60,
  description: "Quarantine a generated OpenClaw shell snapshot after 30 days",
  rootCode: "openclaw-shell-snapshot-retention",
  rootDetail:
    "OpenClaw regenerates exec shell snapshots and sweeps stale captures after three days.",
  tooRecentDetail: "The shell snapshot is inside the 30-day quarantine threshold.",
  contentPrefix: "# OpenClaw exec shell snapshot. Generated; do not edit.\n",
  matchesRelativePath(relativePath) {
    const parts = relativePath.split(sep);
    return (
      parts.length === 3 &&
      parts[0] === "cache" &&
      parts[1] === "shell-snapshots" &&
      /^[a-f0-9]{64}\.sh$/u.test(parts[2]!)
    );
  },
});

export const CLAUDE_DEBUG_LOG_POLICY = fileQuarantinePolicy("Claude debug logs", {
  id: CLAUDE_DEBUG_LOG_POLICY_ID,
  provider: "claude",
  ownerRoot: "provider-root",
  resourceKind: "agent-log-store",
  displayName: "Claude debug log",
  minAgeMinutes: CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES,
  quarantineTtlMinutes: CLAUDE_DEBUG_LOG_QUARANTINE_TTL_MINUTES,
  description: "Quarantine a Claude debug log older than 30 days",
  rootCode: "claude-debug-log-owner-contract",
  rootDetail:
    "Claude documents direct debug logs as disposable application data with no user-facing loss.",
  tooRecentDetail: "The debug log is newer than the 30-day cleanup threshold.",
  matchesRelativePath: isClaudeDebugLogRelativePath,
});

export const CLAUDE_CHANGELOG_CACHE_POLICY = fileQuarantinePolicy("Claude changelog caches", {
  id: CLAUDE_CHANGELOG_CACHE_POLICY_ID,
  provider: "claude",
  ownerRoot: "provider-root",
  resourceKind: "agent-cache",
  displayName: "Claude changelog cache",
  minAgeMinutes: CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES,
  quarantineTtlMinutes: CLAUDE_CHANGELOG_CACHE_QUARANTINE_TTL_MINUTES,
  description: "Quarantine the Claude changelog cache after 30 days",
  rootCode: "claude-changelog-cache-owner-contract",
  rootDetail:
    "Claude documents cache/changelog.md as a rebuildable release-notes cache refreshed in the background.",
  tooRecentDetail: "The changelog cache is newer than the 30-day cleanup threshold.",
  matchesRelativePath: isClaudeChangelogCacheRelativePath,
});

export const ZED_ROTATED_LOG_POLICY = fileQuarantinePolicy("Zed rotated logs", {
  id: ZED_ROTATED_LOG_POLICY_ID,
  provider: "zed",
  ownerRoot: "zed-log-root",
  resourceKind: "agent-log-store",
  displayName: "Zed rotated log",
  minAgeMinutes: ZED_ROTATED_LOG_MIN_AGE_MINUTES,
  quarantineTtlMinutes: ZED_ROTATED_LOG_QUARANTINE_TTL_MINUTES,
  description: "Quarantine Zed.log.old after 30 days",
  rootCode: "zed-rotated-log-owner-contract",
  rootDetail:
    "Zed defines Zed.log.old as the single rotated application log beside the active Zed.log.",
  tooRecentDetail: "The rotated Zed log is newer than the 30-day cleanup threshold.",
  matchesRelativePath: isZedRotatedLogRelativePath,
});

export const PROVIDER_FILE_POLICIES: readonly ProviderFilePolicy[] = [
  OPENCLAW_SHELL_SNAPSHOT_POLICY,
  CLAUDE_DEBUG_LOG_POLICY,
  CLAUDE_CHANGELOG_CACHE_POLICY,
  ZED_ROTATED_LOG_POLICY,
];

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
  const policy = PROVIDER_FILE_POLICIES.find(
    (candidate) => candidate.id === action.policyId && candidate.provider === action.adapter,
  );
  if (policy === undefined || !policy.matchesRelativePath(action.target.relativePath)) {
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
  const refusal = policy.validateAction(action, now);
  if (refusal !== undefined) {
    throw new Error(
      `provider-file action violates policy ${action.adapter}:${action.policyId}: ${refusal}`,
    );
  }
}
