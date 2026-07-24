import { createHash } from "node:crypto";

import { z } from "zod";

import { diagnosticSchema } from "./diagnostic.js";
import { worktreeIdentitySchema } from "./action.js";

export const quarantineEntryIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, "entry ID must be filename-safe");

export function quarantineRecoveryRef(runId: string, resourceId: string): string {
  const resourceHash = createHash("sha256").update(resourceId).digest("hex").slice(0, 16);
  return `refs/agentrinse/quarantine/${runId}/${resourceHash}`;
}

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
    entryId: quarantineEntryIdSchema,
    runId: quarantineEntryIdSchema,
    actionId: z.string().min(1),
    resourceId: z.string().min(1),
    status: quarantineStatusSchema,
    originalPath: z.string().min(1),
    quarantinePath: z.string().min(1),
    recoveryRef: z.string().startsWith("refs/agentrinse/quarantine/"),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    measurementMaxEntries: z.number().int().positive().max(1_000_000),
    target: worktreeIdentitySchema,
    quarantineIdentity: worktreeIdentitySchema.optional(),
    restoredAt: z.string().datetime().optional(),
    purgedAt: z.string().datetime().optional(),
    diagnostic: diagnosticSchema.optional(),
  })
  .superRefine((entry, context) => {
    if (entry.recoveryRef !== quarantineRecoveryRef(entry.runId, entry.resourceId)) {
      context.addIssue({
        code: "custom",
        message: "recovery ref must match the quarantine run and resource",
        path: ["recoveryRef"],
      });
    }
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
