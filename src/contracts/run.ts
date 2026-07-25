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

const actionExecutionBaseSchema = z.object({
  actionId: z.string().min(1),
  status: actionExecutionStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  reclaimedBytes: z.number().int().nonnegative().optional(),
  diagnostic: diagnosticSchema.optional(),
});

export const artifactActionExecutionSchema = actionExecutionBaseSchema.extend({
  type: z.literal("artifacts.remove"),
  isolationPath: z.string().min(1).optional(),
});

export const worktreeActionExecutionSchema = actionExecutionBaseSchema.extend({
  type: z.literal("worktree.quarantine"),
  quarantineEntryId: z.string().min(1).optional(),
  quarantinePath: z.string().min(1).optional(),
  recoveryRef: z.string().min(1).optional(),
  quarantinedBytes: z.number().int().nonnegative().optional(),
});

export const databaseActionExecutionSchema = actionExecutionBaseSchema.extend({
  type: z.literal("database.vacuum"),
  backupEntryId: z.string().min(1).optional(),
  backupPath: z.string().min(1).optional(),
  originalBytes: z.number().int().nonnegative().optional(),
  compactedBytes: z.number().int().nonnegative().optional(),
  retainedBackupBytes: z.number().int().nonnegative().optional(),
});

export const providerFileActionExecutionSchema = actionExecutionBaseSchema.extend({
  type: z.literal("provider.file-quarantine"),
  quarantineEntryId: z.string().min(1).optional(),
  quarantinePath: z.string().min(1).optional(),
  quarantinedBytes: z.number().int().nonnegative().optional(),
});

export const actionExecutionSchema = z.discriminatedUnion("type", [
  artifactActionExecutionSchema,
  worktreeActionExecutionSchema,
  databaseActionExecutionSchema,
  providerFileActionExecutionSchema,
]);

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
  quarantinedBytes: z.number().int().nonnegative().optional(),
  diagnostics: z.array(diagnosticSchema),
});

export type ActionExecutionStatus = z.infer<typeof actionExecutionStatusSchema>;
export type ActionExecution = z.infer<typeof actionExecutionSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type CleanupRun = z.infer<typeof cleanupRunSchema>;
