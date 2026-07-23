import { z } from "zod";

import { diagnosticSchema } from "./diagnostic.js";
import { findingSchema } from "./finding.js";

export const adapterStatusSchema = z.enum([
  "available",
  "absent",
  "degraded",
  "disabled",
  "unsupported",
]);

export const adapterProbeSchema = z.object({
  adapter: z.string().min(1),
  status: adapterStatusSchema,
  version: z.string().min(1).optional(),
  root: z.string().min(1).optional(),
  detail: z.string().min(1),
  diagnostics: z.array(diagnosticSchema),
});

export const auditReportSchema = z.object({
  schemaVersion: z.literal(1),
  auditId: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  home: z.string().min(1),
  probes: z.array(adapterProbeSchema),
  findings: z.array(findingSchema),
  diagnostics: z.array(diagnosticSchema),
});

export type AdapterStatus = z.infer<typeof adapterStatusSchema>;
export type AdapterProbe = z.infer<typeof adapterProbeSchema>;
export type AuditReport = z.infer<typeof auditReportSchema>;

