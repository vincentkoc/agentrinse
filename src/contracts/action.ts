import { z } from "zod";

export const actionRiskSchema = z.enum(["safe", "recoverable", "destructive", "experimental"]);

export const pathIdentitySchema = z.object({
  path: z.string().min(1),
  projectRoot: z.string().min(1),
  name: z.string().min(1),
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  measuredBytes: z.number().int().nonnegative(),
});

export const artifactRemoveActionSchema = z.object({
  actionId: z.string().min(1),
  type: z.literal("artifacts.remove"),
  adapter: z.literal("artifacts"),
  resourceId: z.string().min(1),
  risk: z.literal("safe"),
  description: z.string().min(1),
  expectedReclaimBytes: z.number().int().nonnegative(),
  target: pathIdentitySchema,
});

export const plannedActionSchema = z.discriminatedUnion("type", [artifactRemoveActionSchema]);

export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type PathIdentity = z.infer<typeof pathIdentitySchema>;
export type ArtifactRemoveAction = z.infer<typeof artifactRemoveActionSchema>;
export type PlannedAction = z.infer<typeof plannedActionSchema>;
