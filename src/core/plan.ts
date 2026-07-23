import type { AgentRinseConfig } from "../config/schema.js";
import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import type { AuditReport } from "../contracts/report.js";
import { sha256, type JsonValue } from "./digest.js";

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function createCleanupPlan(
  audit: AuditReport,
  config: AgentRinseConfig,
  now = new Date(),
): CleanupPlan {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.plan.ttlMinutes * 60_000).toISOString();
  const configDigest = sha256(toJsonValue(config));
  const auditDigest = sha256(toJsonValue(audit));
  const planWithoutId = {
    schemaVersion: 1 as const,
    auditId: audit.auditId,
    createdAt,
    expiresAt,
    policyVersion: 1 as const,
    riskCeiling: config.plan.maxRisk,
    configDigest,
    auditDigest,
    actions: [],
    expectedReclaimBytes: 0,
  };

  return cleanupPlanSchema.parse({
    ...planWithoutId,
    planId: sha256(toJsonValue(planWithoutId)),
  });
}
