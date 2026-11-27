import { z } from "zod";

import { artifactNameSchema, type ArtifactName } from "../contracts/action.js";
import { fileRules } from "../rules/file-rule.js";
import { laneCacheRules } from "../rules/openclaw/lane-caches.js";
import { storageLocations } from "../rules/storage/catalog.js";

const threshold = z.number().int().nonnegative();
const artifactOverride = z.strictObject({
  enabled: z.boolean().optional(),
  minAgeMinutes: threshold.optional(),
  minBytes: threshold.optional(),
});
export const artifactOverridesSchema = z.partialRecord(artifactNameSchema, artifactOverride);

type ArtifactThresholds = {
  minAgeMinutes: number;
  minBytes: number;
  byName?: z.infer<typeof artifactOverridesSchema> | undefined;
};

export function artifactPolicy(options: ArtifactThresholds, name: ArtifactName) {
  const override = options.byName?.[name];
  return {
    enabled: override?.enabled ?? true,
    minAgeMinutes: override?.minAgeMinutes ?? options.minAgeMinutes,
    minBytes: override?.minBytes ?? options.minBytes,
  };
}

// Each installed rule publishes its own safety floors in both the parser and JSON schema.
const providerShape = Object.fromEntries(
  fileRules.map(
    (rule) =>
      [
        rule.id,
        z
          .strictObject({
            enabled: z.boolean().optional(),
            minAgeMinutes: threshold.min(rule.minAgeMinutes).optional(),
            quarantineTtlMinutes: threshold
              .min(rule.quarantineTtlMinutes)
              .max(5_256_000)
              .optional(),
          })
          .optional(),
      ] as const,
  ),
);
export const providerRulesSchema = z.strictObject(providerShape);
export type ProviderRules = z.infer<typeof providerRulesSchema>;

export function providerFilePolicy(rule: (typeof fileRules)[number], rules?: ProviderRules) {
  const override = rules?.[rule.id];
  return {
    enabled: override?.enabled ?? true,
    minAgeMinutes: override?.minAgeMinutes ?? rule.minAgeMinutes,
    quarantineTtlMinutes: override?.quarantineTtlMinutes ?? rule.quarantineTtlMinutes,
  };
}

export const storageFamilies = [
  "developer",
  "retained",
  "vm",
  "mounts",
  "crabbox",
  "openclaw",
  "git",
] as const;
export const storageRuleIds = [
  ...new Set([...storageLocations, ...laneCacheRules].map((rule) => rule.id)),
].sort();
export const storageOptionsSchema = z.strictObject({
  reviewAgeMinutes: z
    .partialRecord(
      z.enum(laneCacheRules.map((rule) => rule.id)),
      z.number().int().positive().max(5_256_000),
    )
    .optional(),
  families: z.array(z.enum(storageFamilies)).min(1).optional(),
  rules: z.array(z.enum(storageRuleIds)).min(1).optional(),
  system: z.boolean().optional(),
});
