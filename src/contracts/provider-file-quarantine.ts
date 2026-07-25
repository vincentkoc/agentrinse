import { z } from "zod";

import { providerFileIdentitySchema } from "./action.js";
import { diagnosticSchema } from "./diagnostic.js";
import { quarantineEntryIdSchema } from "./quarantine.js";

export const providerFileQuarantineStatusSchema = z.enum([
  "preparing",
  "quarantined",
  "restoring",
  "restored",
  "purging",
  "purged",
  "partial",
]);

export const providerFileQuarantineEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    entryId: quarantineEntryIdSchema,
    runId: quarantineEntryIdSchema,
    actionId: z.string().min(1),
    resourceId: z.string().min(1),
    policyId: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/u),
    status: providerFileQuarantineStatusSchema,
    originalPath: z.string().min(1),
    quarantinePath: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    target: providerFileIdentitySchema,
    quarantineIdentity: providerFileIdentitySchema.optional(),
    restoredAt: z.string().datetime().optional(),
    purgedAt: z.string().datetime().optional(),
    diagnostic: diagnosticSchema.optional(),
  })
  .superRefine((entry, context) => {
    if (
      ["quarantined", "restoring", "purging", "partial"].includes(entry.status) &&
      entry.quarantineIdentity === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "live provider-file quarantine state requires quarantine identity",
        path: ["quarantineIdentity"],
      });
    }
  });

export type ProviderFileQuarantineStatus = z.infer<typeof providerFileQuarantineStatusSchema>;
export type ProviderFileQuarantineEntry = z.infer<typeof providerFileQuarantineEntrySchema>;
