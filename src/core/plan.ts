import type { AgentRinseConfig } from "../config/schema.js";
import { actionRiskSchema } from "../contracts/action.js";
import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import type { AuditReport } from "../contracts/report.js";
import { sha256Json } from "./digest.js";

export function cleanupPlanId(plan: Omit<CleanupPlan, "planId">): string {
  return sha256Json(plan);
}

export function createCleanupPlan(
  audit: AuditReport,
  config: AgentRinseConfig,
  now = new Date(),
): CleanupPlan {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.plan.ttlMinutes * 60_000).toISOString();
  const configDigest = sha256Json(config);
  const auditDigest = sha256Json(audit);
  const riskLevels = actionRiskSchema.options;
  const permittedRisks = riskLevels.slice(0, riskLevels.indexOf(config.plan.maxRisk) + 1);
  const actions = audit.findings
    .filter((finding) => finding.state === "eligible")
    .flatMap((finding) => finding.candidateActions)
    .filter((action) => permittedRisks.includes(action.risk))
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
  const planWithoutId = {
    schemaVersion: 1 as const,
    auditId: audit.auditId,
    home: audit.home,
    createdAt,
    expiresAt,
    policyVersion: 1 as const,
    riskCeiling: config.plan.maxRisk,
    configDigest,
    auditDigest,
    actions,
    expectedReclaimBytes: actions.reduce((total, action) => total + action.expectedReclaimBytes, 0),
    pendingQuarantineBytes: actions.reduce(
      (total, action) =>
        total +
        (action.type === "worktree.quarantine" || action.type === "provider.file-quarantine"
          ? action.pendingQuarantineBytes
          : 0),
      0,
    ),
  };

  return cleanupPlanSchema.parse({
    ...planWithoutId,
    planId: cleanupPlanId(planWithoutId),
  });
}
