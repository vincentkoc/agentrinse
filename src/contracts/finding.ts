import { z } from "zod";

import { plannedActionSchema } from "./action.js";
import { diagnosticSchema } from "./diagnostic.js";
import { resourceRefSchema } from "./resource.js";

export const findingStateSchema = z.enum([
  "protected",
  "eligible",
  "blocked",
  "unknown",
  "ignored",
]);

export const findingConfidenceSchema = z.enum(["certain", "high", "medium", "low", "unknown"]);

export const rootEvidenceSchema = z.object({
  code: z.string().min(1),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  detail: z.string().min(1),
  evidenceRef: z.string().min(1).optional(),
});

export const findingSchema = z.object({
  schemaVersion: z.literal(1),
  findingId: z.string().min(1),
  auditId: z.string().min(1),
  observedAt: z.string().datetime(),
  resource: resourceRefSchema,
  state: findingStateSchema,
  confidence: findingConfidenceSchema,
  roots: z.array(rootEvidenceSchema),
  facts: z.record(z.string(), z.unknown()),
  candidateActions: z.array(plannedActionSchema),
  measuredBytes: z.number().int().nonnegative().optional(),
  estimatedReclaimBytes: z.number().int().nonnegative().optional(),
  warnings: z.array(diagnosticSchema),
});

export type FindingState = z.infer<typeof findingStateSchema>;
export type FindingConfidence = z.infer<typeof findingConfidenceSchema>;
export type RootEvidence = z.infer<typeof rootEvidenceSchema>;
export type Finding = z.infer<typeof findingSchema>;
