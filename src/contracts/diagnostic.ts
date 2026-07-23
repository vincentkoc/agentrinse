import { z } from "zod";

export const diagnosticSeveritySchema = z.enum(["info", "warning", "error"]);

export const diagnosticSchema = z.object({
  severity: diagnosticSeveritySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  adapter: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  remediation: z.string().min(1).optional(),
});

export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
