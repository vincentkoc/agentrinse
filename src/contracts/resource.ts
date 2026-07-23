import { z } from "zod";

export const resourceKindSchema = z.enum([
  "git-worktree",
  "build-artifact",
  "agent-home",
  "agent-session-store",
  "agent-log-store",
  "agent-database",
  "agent-snapshot-store",
  "agent-runtime",
  "docker-container",
  "docker-image",
  "docker-network",
  "docker-volume",
  "docker-build-cache",
]);

export const resourceRefSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  kind: resourceKindSchema,
  canonicalKey: z.string().min(1),
  displayName: z.string().min(1),
  path: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
});

export const resourceSnapshotSchema = z.object({
  resource: resourceRefSchema,
  observedAt: z.string().datetime(),
  exists: z.boolean(),
  measuredBytes: z.number().int().nonnegative().optional(),
  facts: z.record(z.string(), z.unknown()),
});

export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
