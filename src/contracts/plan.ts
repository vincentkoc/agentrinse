import { z } from "zod";

import { actionRiskSchema, plannedActionSchema } from "./action.js";

export const cleanupPlanSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  auditId: z.string().min(1),
  home: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  policyVersion: z.literal(1),
  riskCeiling: actionRiskSchema,
  configDigest: z.string().min(1),
  auditDigest: z.string().min(1),
  actions: z.array(plannedActionSchema),
  expectedReclaimBytes: z.number().int().nonnegative(),
});

export type { ActionRisk, PlannedAction } from "./action.js";
export type CleanupPlan = z.infer<typeof cleanupPlanSchema>;
