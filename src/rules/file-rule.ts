import { sep } from "node:path";
import { z } from "zod";

import { providerMutationIdSchema } from "../contracts/action.js";
import { fileRuleDefinitions } from "./builtin.generated.js";

const component = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/u)
  .refine((s) => s !== "." && s !== "..");
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
      z.strictObject({ kind: z.literal("native") }),
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
      (rule.provider === "openclaw" && rule.discovery.kind !== "native")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "File rule disagrees with its owner or discovery method",
      });
    }
  });

export type ProviderFileRule = z.infer<typeof providerFileRuleSchema>;

export function matchesRulePath(rule: ProviderFileRule, relativePath: string): boolean {
  const parts = relativePath.split(sep);
  const name = parts.pop();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    parts.length !== rule.directory.length ||
    !parts.every((part, i) => part === rule.directory[i])
  )
    return false;
  if ("name" in rule.match) return name === rule.match.name;
  if ("suffix" in rule.match) return name.endsWith(rule.match.suffix);
  const suffix = rule.match.sha256Suffix;
  return name.endsWith(suffix) && /^[a-f0-9]{64}$/u.test(name.slice(0, -suffix.length));
}

export const fileRules = fileRuleDefinitions
  .map((definition) => {
    const rule = providerFileRuleSchema.parse(definition);
    return {
      ...rule,
      minAgeMinutes: rule.minAgeDays * 1440,
      quarantineTtlMinutes: rule.quarantineDays * 1440,
    };
  })
  .sort(
    (left, right) =>
      (left.discovery.kind === "native" ? 100 : (left.discovery.order ?? 100)) -
      (right.discovery.kind === "native" ? 100 : (right.discovery.order ?? 100)),
  );

export function matchProviderFilePolicy(provider: string, id: unknown, relativePath: string) {
  return fileRules.find(
    (rule) => rule.provider === provider && rule.id === id && matchesRulePath(rule, relativePath),
  );
}
