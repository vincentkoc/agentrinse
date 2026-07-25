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

const providerFileQuarantineEntryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  entryId: quarantineEntryIdSchema,
  runId: quarantineEntryIdSchema,
  actionId: z.string().min(1),
  resourceId: z.string().min(1),
  policyId: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/u),
  originalPath: z.string().min(1),
  quarantinePath: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  target: providerFileIdentitySchema,
  restoredAt: z.string().datetime().optional(),
  purgedAt: z.string().datetime().optional(),
  diagnostic: diagnosticSchema.optional(),
});

const providerFileQuarantineStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("preparing"),
    quarantineIdentity: providerFileIdentitySchema.optional(),
  }),
  z.object({
    status: z.literal("quarantined"),
    quarantineIdentity: providerFileIdentitySchema,
  }),
  z.object({
    status: z.literal("restoring"),
    quarantineIdentity: providerFileIdentitySchema,
  }),
  z.object({
    status: z.literal("restored"),
    quarantineIdentity: providerFileIdentitySchema.optional(),
  }),
  z.object({
    status: z.literal("purging"),
    quarantineIdentity: providerFileIdentitySchema,
  }),
  z.object({
    status: z.literal("purged"),
    quarantineIdentity: providerFileIdentitySchema.optional(),
  }),
  z.object({
    status: z.literal("partial"),
    quarantineIdentity: providerFileIdentitySchema,
  }),
]);

export const providerFileQuarantineEntrySchema = providerFileQuarantineEntryBaseSchema.and(
  providerFileQuarantineStateSchema,
);

export type ProviderFileQuarantineStatus = z.infer<typeof providerFileQuarantineStatusSchema>;
export type ProviderFileQuarantineEntry = z.infer<typeof providerFileQuarantineEntrySchema>;
