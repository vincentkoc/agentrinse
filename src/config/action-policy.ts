import { resolve } from "node:path";

import type { AgentRinseConfig } from "./schema.js";
import { artifactPolicy, providerFilePolicy, type ProviderRules } from "./rule-options.js";
import type {
  PlannedAction,
  ProviderFileQuarantineAction,
  ArtifactRemoveAction,
} from "../contracts/action.js";
import { matchProviderFilePolicy } from "../rules/file-rule.js";
import { isProviderEnabled } from "../adapters/provider-specs.js";

export function validateRecoveryWindow(
  action: ProviderFileQuarantineAction,
  rule: NonNullable<ReturnType<typeof matchProviderFilePolicy>>,
  now: Date,
  rules?: ProviderRules,
): string | undefined {
  const policy = providerFilePolicy(rule, rules);
  if (!policy.enabled) return "this quarantine rule is disabled";
  if (action.pendingQuarantineBytes !== action.target.measuredBytes) {
    return "pending quarantine bytes must match the exact file identity";
  }
  if (action.quarantineTtlMinutes < policy.quarantineTtlMinutes) {
    if (policy.quarantineTtlMinutes !== rule.quarantineTtlMinutes)
      return `configured quarantine requires at least ${policy.quarantineTtlMinutes} minutes`;
    const days = rule.quarantineDays === 7 ? "seven" : rule.quarantineDays;
    return `${rule.subject} require at least ${days} days of recoverable quarantine`;
  }
  if (now.getTime() - action.target.mtimeMs < policy.minAgeMinutes * 60_000) {
    if (policy.minAgeMinutes !== rule.minAgeMinutes)
      return `file must be at least ${policy.minAgeMinutes} minutes old`;
    return `${rule.subject} must be at least ${rule.minAgeDays} days old`;
  }
}

export function artifactProjectEnabled(
  action: ArtifactRemoveAction,
  config: AgentRinseConfig,
): boolean {
  const root = resolve(action.target.projectRoot);
  return config.artifacts.projects.some(
    (project) => resolve(project.root) === root && project.names.includes(action.target.name),
  );
}

// An old audit supplies observations. Only its already eligible actions may survive a new policy.
export function actionMeetsPolicy(
  action: PlannedAction,
  config: AgentRinseConfig,
  now: Date,
): boolean {
  switch (action.type) {
    case "provider.file-quarantine": {
      const rule = matchProviderFilePolicy(
        action.adapter,
        action.policyId,
        action.target.relativePath,
      );
      return (
        isProviderEnabled(config, action.adapter) &&
        rule !== undefined &&
        validateRecoveryWindow(action, rule, now, config.providerRules) === undefined
      );
    }
    case "artifacts.remove": {
      const policy = artifactPolicy(config.artifacts, action.target.name);
      return (
        artifactProjectEnabled(action, config) &&
        policy.enabled &&
        action.target.measuredBytes >= policy.minBytes &&
        now.getTime() - action.target.newestMtimeMs >= policy.minAgeMinutes * 60_000
      );
    }
    case "worktree.quarantine":
      return (
        config.worktrees.enabled !== false &&
        config.adapters.git?.enabled === true &&
        now.getTime() - action.target.newestMtimeMs >= config.worktrees.minAgeMinutes * 60_000 &&
        action.quarantineTtlMinutes === config.worktrees.quarantineTtlMinutes
      );
    case "database.vacuum":
      return isProviderEnabled(config, "codex") && config.codexVacuum?.enabled !== false;
  }
}
