import { z } from "zod";

import { diagnosticSchema } from "./diagnostic.js";
import { worktreeIdentitySchema } from "./action.js";

export const quarantineStatusSchema = z.enum([
  "preparing",
  "recovery-ref-created",
  "moved",
  "quarantined",
  "restoring",
  "restored",
  "purging",
  "purged",
  "partial",
]);

export const quarantineEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    entryId: z.string().min(1),
    runId: z.string().min(1),
    actionId: z.string().min(1),
    resourceId: z.string().min(1),
    status: quarantineStatusSchema,
    originalPath: z.string().min(1),
    quarantinePath: z.string().min(1),
    recoveryRef: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    target: worktreeIdentitySchema,
    quarantineIdentity: worktreeIdentitySchema.optional(),
    restoredAt: z.string().datetime().optional(),
    purgedAt: z.string().datetime().optional(),
    diagnostic: diagnosticSchema.optional(),
  })
  .superRefine((entry, context) => {
    if (
      ["quarantined", "restoring", "purging", "purged"].includes(entry.status) &&
      entry.quarantineIdentity === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "completed quarantine state requires post-repair identity",
        path: ["quarantineIdentity"],
      });
    }
  });

export type QuarantineStatus = z.infer<typeof quarantineStatusSchema>;
export type QuarantineEntry = z.infer<typeof quarantineEntrySchema>;
