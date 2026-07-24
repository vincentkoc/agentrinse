import { z } from "zod";

export const doctorCheckSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pass", "warning", "error"]),
  summary: z.string().min(1),
  detail: z.string().min(1).optional(),
  remediation: z.string().min(1).optional(),
});

export const doctorReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.enum(["ok", "warning", "error"]),
  checks: z.array(doctorCheckSchema),
});

export type DoctorCheck = z.infer<typeof doctorCheckSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;
