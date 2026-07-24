import { z } from "zod";

import { diagnosticSchema, type Diagnostic } from "./diagnostic.js";

export const commandEnvelopeStatusSchema = z.enum(["ok", "degraded", "failed"]);

export const commandEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  command: z.string().min(1),
  agentrinseVersion: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  status: commandEnvelopeStatusSchema,
  data: z.unknown(),
  diagnostics: z.array(diagnosticSchema),
});

export const commandEventSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  command: z.string().min(1),
  commandId: z.string().min(1),
  sequence: z.number().int().positive(),
  data: z.unknown().optional(),
});

export type CommandEnvelopeStatus = z.infer<typeof commandEnvelopeStatusSchema>;
export type CommandEnvelope<T> = Omit<z.infer<typeof commandEnvelopeSchema>, "data"> & {
  data: T;
  diagnostics: Diagnostic[];
};
export type CommandEvent<T = unknown> = Omit<z.infer<typeof commandEventSchema>, "data"> & {
  data?: T;
};
