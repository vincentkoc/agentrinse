import { z } from "zod";

export const adapterIdSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "copilot",
  "zed",
  "opencode",
  "grok",
  "git",
  "docker",
]);

const adapterConfigSchema = z.object({
  enabled: z.boolean(),
  root: z.string().min(1).optional(),
});

export const agentRinseConfigSchema = z.object({
  schemaVersion: z.literal(1),
  adapters: z.record(adapterIdSchema, adapterConfigSchema.partial()).default({}),
  audit: z
    .object({
      maxEntries: z.number().int().positive().max(1_000_000).default(100_000),
      measureBytes: z.boolean().default(true),
    })
    .default({}),
  plan: z
    .object({
      ttlMinutes: z.number().int().positive().max(24 * 60).default(30),
      maxRisk: z
        .enum(["safe", "recoverable", "destructive", "experimental"])
        .default("safe"),
    })
    .default({}),
});

export type AdapterId = z.infer<typeof adapterIdSchema>;
export type AgentRinseConfig = z.infer<typeof agentRinseConfigSchema>;

