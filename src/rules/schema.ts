import { z } from "zod";
import { providerMutationIdSchema } from "../contracts/action.js";

const component = z.string().regex(/^(?!\.{1,2}$)[a-zA-Z0-9_.-]+$/u);
const extension = z.string().regex(/^\.[a-zA-Z0-9]+$/u);
const text = z.string().min(1);
const fileDiscovery = {
  includeBasename: z.boolean(),
  order: z.number().int().optional(),
  inspectionFailed: text,
};
export const providerFileRuleSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u),
    kind: z.literal("provider-file"),
    provider: providerMutationIdSchema,
    ownerRoot: z.enum(["provider-root", "zed-log-root"]),
    directory: z.array(component),
    match: z.union([
      z.strictObject({ name: component }),
      z.strictObject({ suffix: extension }),
      z.strictObject({ sha256Suffix: extension }),
    ]),
    discovery: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("native"),
        collector: z.literal("openclaw-shell-snapshot"),
      }),
      z.strictObject({
        kind: z.literal("exact"),
        ...fileDiscovery,
        rootUnsafe: text.optional(),
        rootUnsafeMessage: text.optional(),
        rootInspectionFailed: text.optional(),
      }),
      z.strictObject({
        kind: z.literal("children"),
        ...fileDiscovery,
        enumerationFailed: text,
        truncated: text,
        limitLabel: text,
      }),
    ]),
    resourceKind: z.enum(["agent-cache", "agent-log-store"]),
    displayName: text,
    minAgeDays: z.number().int().positive(),
    quarantineDays: z.number().int().positive(),
    subject: text,
    description: text,
    rootCode: text,
    rootDetail: text,
    tooRecentDetail: text,
    contentPrefix: text.optional(),
  })
  .superRefine((rule, ctx) => {
    if (
      !rule.id.startsWith(rule.provider + ".") ||
      (rule.ownerRoot === "zed-log-root" && rule.provider !== "zed") ||
      (rule.discovery.kind === "exact" && !("name" in rule.match)) ||
      (rule.provider === "openclaw" && rule.discovery.kind !== "native") ||
      (rule.discovery.kind === "native" &&
        (rule.provider !== "openclaw" ||
          !rule.contentPrefix ||
          rule.directory.length !== 2 ||
          rule.directory[0] !== "cache" ||
          !("sha256Suffix" in rule.match)))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "File rule disagrees with its owner or discovery method",
      });
    }
  });

export type ProviderFileRule = z.infer<typeof providerFileRuleSchema>;

export const projectArtifactRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u),
  kind: z.literal("project-artifacts"),
  names: z.array(component.refine((value) => value.toLowerCase() !== ".git")).min(1),
});

export const cleanupRuleSchema = z.union([providerFileRuleSchema, projectArtifactRuleSchema]);
