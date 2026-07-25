import { z } from "zod";

import { databaseIdentitySchema } from "./action.js";
import { diagnosticSchema } from "./diagnostic.js";
import { quarantineEntryIdSchema } from "./quarantine.js";

export const databaseBackupStatusSchema = z.enum([
  "preparing",
  "vacuumed",
  "original-backed-up",
  "installed",
  "restoring",
  "restored",
  "purging",
  "purged",
  "partial",
]);

export const databaseBackupEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    entryId: quarantineEntryIdSchema,
    runId: quarantineEntryIdSchema,
    actionId: z.string().min(1),
    resourceId: z.string().min(1),
    status: databaseBackupStatusSchema,
    originalPath: z.string().min(1),
    backupPath: z.string().min(1),
    backupWalPath: z.string().min(1).optional(),
    backupShmPath: z.string().min(1).optional(),
    temporaryPath: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    target: databaseIdentitySchema,
    backupIdentity: databaseIdentitySchema.optional(),
    installedIdentity: databaseIdentitySchema.optional(),
    restoredAt: z.string().datetime().optional(),
    purgedAt: z.string().datetime().optional(),
    diagnostic: diagnosticSchema.optional(),
  })
  .superRefine((entry, context) => {
    if ((entry.target.wal === undefined) !== (entry.backupWalPath === undefined)) {
      context.addIssue({
        code: "custom",
        message: "database WAL backup path must match the planned sidecar",
        path: ["backupWalPath"],
      });
    }
    if ((entry.target.shm === undefined) !== (entry.backupShmPath === undefined)) {
      context.addIssue({
        code: "custom",
        message: "database SHM backup path must match the planned sidecar",
        path: ["backupShmPath"],
      });
    }
    if (
      ["original-backed-up", "installed", "restoring", "purging", "purged"].includes(
        entry.status,
      ) &&
      entry.backupIdentity === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "database backup state requires the retained original identity",
        path: ["backupIdentity"],
      });
    }
    if (
      ["installed", "restoring", "purging", "purged"].includes(entry.status) &&
      entry.installedIdentity === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "installed database state requires the compacted identity",
        path: ["installedIdentity"],
      });
    }
  });

export type DatabaseBackupStatus = z.infer<typeof databaseBackupStatusSchema>;
export type DatabaseBackupEntry = z.infer<typeof databaseBackupEntrySchema>;
