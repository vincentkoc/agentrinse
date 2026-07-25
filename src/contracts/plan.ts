import { z } from "zod";

import { actionRiskSchema, plannedActionSchema } from "./action.js";

export const cleanupPlanSchema = z
  .object({
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
    pendingQuarantineBytes: z.number().int().nonnegative().optional(),
  })
  .superRefine((plan, context) => {
    const actionIds = new Set<string>();
    const targetPaths = new Set<string>();
    let expectedReclaimBytes = 0;
    let pendingQuarantineBytes = 0;

    for (const [index, action] of plan.actions.entries()) {
      if (actionIds.has(action.actionId)) {
        context.addIssue({
          code: "custom",
          message: "cleanup plan contains a duplicate actionId",
          path: ["actions", index, "actionId"],
        });
      }
      actionIds.add(action.actionId);

      if (targetPaths.has(action.target.path)) {
        context.addIssue({
          code: "custom",
          message: "cleanup plan contains duplicate target paths",
          path: ["actions", index, "target", "path"],
        });
      }
      targetPaths.add(action.target.path);

      if (
        action.type === "worktree.quarantine" ||
        action.type === "provider.file-quarantine"
      ) {
        if (action.pendingQuarantineBytes !== action.target.measuredBytes) {
          context.addIssue({
            code: "custom",
            message: "quarantine estimate must match the measured target bytes",
            path: ["actions", index, "pendingQuarantineBytes"],
          });
        }
        pendingQuarantineBytes += action.pendingQuarantineBytes;
      } else if (
        action.type === "artifacts.remove" &&
        action.expectedReclaimBytes !== action.target.measuredBytes
      ) {
        context.addIssue({
          code: "custom",
          message: "action reclaim estimate must match the measured target bytes",
          path: ["actions", index, "expectedReclaimBytes"],
        });
      } else if (
        action.type === "database.vacuum" &&
        action.expectedReclaimBytes > action.target.measuredBytes
      ) {
        context.addIssue({
          code: "custom",
          message: "database reclaim estimate cannot exceed the database size",
          path: ["actions", index, "expectedReclaimBytes"],
        });
      }
      expectedReclaimBytes += action.expectedReclaimBytes;
    }

    if (expectedReclaimBytes !== plan.expectedReclaimBytes) {
      context.addIssue({
        code: "custom",
        message: "plan reclaim estimate must equal the sum of its actions",
        path: ["expectedReclaimBytes"],
      });
    }
    if ((plan.pendingQuarantineBytes ?? 0) !== pendingQuarantineBytes) {
      context.addIssue({
        code: "custom",
        message: "plan pending quarantine bytes must equal the sum of recoverable actions",
        path: ["pendingQuarantineBytes"],
      });
    }
  });

export type { ActionRisk, PlannedAction } from "./action.js";
export type CleanupPlan = z.infer<typeof cleanupPlanSchema>;
