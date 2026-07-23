import type { AgentRinseConfig } from "../config/schema.js";
import type { ActionRisk } from "../contracts/action.js";
import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import type { AuditReport } from "../contracts/report.js";
import { sha256Json } from "./digest.js";

const RISK_ORDER: Record<ActionRisk, number> = {
  safe: 0,
  recoverable: 1,
  destructive: 2,
  experimental: 3,
};

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
  const actions = audit.findings
    .filter((finding) => finding.state === "eligible")
    .flatMap((finding) => finding.candidateActions)
    .filter((action) => RISK_ORDER[action.risk] <= RISK_ORDER[config.plan.maxRisk])
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
  };

  return cleanupPlanSchema.parse({
    ...planWithoutId,
    planId: cleanupPlanId(planWithoutId),
  });
}
