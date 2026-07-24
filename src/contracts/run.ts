import { z } from "zod";

import { diagnosticSchema } from "./diagnostic.js";

export const actionExecutionStatusSchema = z.enum([
  "pending",
  "revalidating",
  "skipped-stale",
  "applying",
  "applied",
  "failed",
  "rolled-back",
  "partially-applied",
]);

export const actionExecutionSchema = z.object({
  actionId: z.string().min(1),
  type: z.literal("artifacts.remove"),
  status: actionExecutionStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  reclaimedBytes: z.number().int().nonnegative().optional(),
  isolationPath: z.string().min(1).optional(),
  diagnostic: diagnosticSchema.optional(),
});

export const runStatusSchema = z.enum(["running", "completed", "partial", "failed", "interrupted"]);

export const cleanupRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  planId: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: runStatusSchema,
  actions: z.array(actionExecutionSchema),
  reclaimedBytes: z.number().int().nonnegative(),
  diagnostics: z.array(diagnosticSchema),
});

export type ActionExecutionStatus = z.infer<typeof actionExecutionStatusSchema>;
export type ActionExecution = z.infer<typeof actionExecutionSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type CleanupRun = z.infer<typeof cleanupRunSchema>;
