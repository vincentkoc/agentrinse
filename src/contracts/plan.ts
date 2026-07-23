import { z } from "zod";

export const actionRiskSchema = z.enum(["safe", "recoverable", "destructive", "experimental"]);

export const plannedActionSchema = z.object({
  actionId: z.string().min(1),
  type: z.string().min(1),
  adapter: z.string().min(1),
  resourceId: z.string().min(1),
  risk: actionRiskSchema,
  description: z.string().min(1),
  expectedReclaimBytes: z.number().int().nonnegative().optional(),
  parameters: z.record(z.string(), z.unknown()),
});

export const cleanupPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  auditId: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  policyVersion: z.literal(1),
  riskCeiling: actionRiskSchema,
  configDigest: z.string().min(1),
  auditDigest: z.string().min(1),
  actions: z.array(plannedActionSchema),
  expectedReclaimBytes: z.number().int().nonnegative(),
});

export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type PlannedAction = z.infer<typeof plannedActionSchema>;
export type CleanupPlan = z.infer<typeof cleanupPlanSchema>;
