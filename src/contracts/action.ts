import { z } from "zod";

export const actionRiskSchema = z.enum(["safe", "recoverable", "destructive", "experimental"]);

export const artifactNameSchema = z.enum([
  "node_modules",
  "dist",
  "dist-runtime",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  ".venv",
]);

export const pathIdentitySchema = z.object({
  path: z.string().min(1),
  projectRoot: z.string().min(1),
  name: artifactNameSchema,
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  measuredBytes: z.number().int().nonnegative(),
  newestMtimeMs: z.number().finite(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
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

export const worktreeIdentitySchema = z.object({
  path: z.string().min(1),
  repositoryCommonDir: z.string().min(1),
  head: z.string().regex(/^[a-f0-9]{40,64}$/u),
  branch: z.string().min(1).optional(),
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  measuredBytes: z.number().int().nonnegative(),
  newestMtimeMs: z.number().finite(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const worktreeQuarantineActionSchema = z.object({
  actionId: z.string().min(1),
  type: z.literal("worktree.quarantine"),
  adapter: z.literal("git"),
  resourceId: z.string().min(1),
  risk: z.literal("recoverable"),
  description: z.string().min(1),
  expectedReclaimBytes: z.literal(0),
  pendingQuarantineBytes: z.number().int().nonnegative(),
  quarantineTtlMinutes: z.number().int().positive(),
  target: worktreeIdentitySchema,
});

export const codexDatabaseNameSchema = z.enum(["state", "logs", "goals", "memories"]);

export const codexDatabaseFilenameSchema = z.enum([
  "state_5.sqlite",
  "logs_2.sqlite",
  "goals_1.sqlite",
  "memories_1.sqlite",
]);

export const databaseSidecarIdentitySchema = z.object({
  path: z.string().min(1),
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  measuredBytes: z.number().int().nonnegative(),
});

export const databaseIdentitySchema = z.object({
  path: z.string().min(1),
  database: codexDatabaseNameSchema,
  filename: codexDatabaseFilenameSchema,
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  measuredBytes: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  freelistCount: z.number().int().nonnegative(),
  journalMode: z.literal("wal"),
  autoVacuum: z.number().int().min(0).max(2),
  migrationVersion: z.number().int().nonnegative(),
  migrationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  tables: z.array(z.string().min(1)),
  wal: databaseSidecarIdentitySchema.optional(),
  shm: databaseSidecarIdentitySchema.optional(),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const databaseVacuumActionSchema = z.object({
  actionId: z.string().min(1),
  type: z.literal("database.vacuum"),
  adapter: z.literal("codex"),
  resourceId: z.string().min(1),
  risk: z.literal("experimental"),
  description: z.string().min(1),
  expectedReclaimBytes: z.number().int().positive(),
  backupTtlMinutes: z.number().int().positive(),
  target: databaseIdentitySchema,
});

export const providerMutationIdSchema = z.enum([
  "claude",
  "cursor",
  "copilot",
  "zed",
  "opencode",
  "grok",
]);

export const providerFileIdentitySchema = z.object({
  path: z.string().min(1),
  ownerRoot: z.string().min(1),
  relativePath: z.string().min(1),
  provider: providerMutationIdSchema,
  device: z.number().int().nonnegative(),
  inode: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite(),
  measuredBytes: z.number().int().nonnegative(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const providerFileQuarantineActionSchema = z.object({
  actionId: z.string().min(1),
  type: z.literal("provider.file-quarantine"),
  adapter: providerMutationIdSchema,
  resourceId: z.string().min(1),
  risk: z.literal("recoverable"),
  description: z.string().min(1),
  expectedReclaimBytes: z.literal(0),
  pendingQuarantineBytes: z.number().int().nonnegative(),
  quarantineTtlMinutes: z.number().int().positive(),
  target: providerFileIdentitySchema,
});

export const plannedActionSchema = z.discriminatedUnion("type", [
  artifactRemoveActionSchema,
  worktreeQuarantineActionSchema,
  databaseVacuumActionSchema,
  providerFileQuarantineActionSchema,
]);

export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type ArtifactName = z.infer<typeof artifactNameSchema>;
export type PathIdentity = z.infer<typeof pathIdentitySchema>;
export type ArtifactRemoveAction = z.infer<typeof artifactRemoveActionSchema>;
export type WorktreeIdentity = z.infer<typeof worktreeIdentitySchema>;
export type WorktreeQuarantineAction = z.infer<typeof worktreeQuarantineActionSchema>;
export type CodexDatabaseName = z.infer<typeof codexDatabaseNameSchema>;
export type CodexDatabaseFilename = z.infer<typeof codexDatabaseFilenameSchema>;
export type DatabaseIdentity = z.infer<typeof databaseIdentitySchema>;
export type DatabaseSidecarIdentity = z.infer<typeof databaseSidecarIdentitySchema>;
export type DatabaseVacuumAction = z.infer<typeof databaseVacuumActionSchema>;
export type ProviderMutationId = z.infer<typeof providerMutationIdSchema>;
export type ProviderFileIdentity = z.infer<typeof providerFileIdentitySchema>;
export type ProviderFileQuarantineAction = z.infer<typeof providerFileQuarantineActionSchema>;
export type PlannedAction = z.infer<typeof plannedActionSchema>;
