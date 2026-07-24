import { isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { artifactNameSchema, type ArtifactName } from "../contracts/action.js";

export const adapterIdSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "copilot",
  "zed",
  "opencode",
  "grok",
  "runtime",
  "git",
  "docker",
]);

const adapterConfigSchema = z.object({
  enabled: z.boolean(),
  root: z.string().min(1).optional(),
});

export const artifactProjectSchema = z.object({
  root: z.string().min(1).refine(isAbsolute, "artifact project root must be absolute"),
  names: z
    .array(artifactNameSchema)
    .min(1)
    .refine((names) => new Set(names).size === names.length, "artifact names must be unique"),
});

const expiresAtSchema = z.string().datetime().optional();

function isValidGitRef(value: string): boolean {
  const match = /^refs\/(?:heads|remotes|tags)\/(.+)$/u.exec(value);
  if (match === null) {
    return false;
  }
  const suffix = match[1]!;
  if (
    suffix.endsWith(".") ||
    suffix.includes("..") ||
    suffix.includes("@{") ||
    suffix.includes("//")
  ) {
    return false;
  }
  for (const component of suffix.split("/")) {
    if (component === "" || component.startsWith(".") || component.endsWith(".lock")) {
      return false;
    }
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || ["~", "^", ":", "?", "*", "[", "\\"].includes(character)) {
      return false;
    }
  }
  return true;
}

export const pinSchema = z.union([
  z
    .object({
      path: z.string().min(1).refine(isAbsolute, "pin path must be absolute"),
      expiresAt: expiresAtSchema,
    })
    .strict(),
  z
    .object({
      resourceId: z.string().min(1),
      expiresAt: expiresAtSchema,
    })
    .strict(),
  z
    .object({
      gitRef: z.string().refine(isValidGitRef, "pin Git ref is invalid"),
      expiresAt: expiresAtSchema,
    })
    .strict(),
]);

function isInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export const agentRinseConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapters: z.partialRecord(adapterIdSchema, adapterConfigSchema.partial()).default(() => ({})),
    audit: z
      .object({
        maxEntries: z.number().int().positive().max(1_000_000).default(100_000),
        measureBytes: z.boolean().default(true),
      })
      .default(() => ({ maxEntries: 100_000, measureBytes: true })),
    artifacts: z
      .object({
        projects: z.array(artifactProjectSchema).default([]),
        minAgeMinutes: z
          .number()
          .int()
          .nonnegative()
          .default(24 * 60),
        minBytes: z
          .number()
          .int()
          .nonnegative()
          .default(64 * 1024 * 1024),
        processCheck: z.literal("required").default("required"),
      })
      .default(() => ({
        projects: [],
        minAgeMinutes: 24 * 60,
        minBytes: 64 * 1024 * 1024,
        processCheck: "required" as const,
      })),
    pins: z.array(pinSchema).default([]),
    plan: z
      .object({
        ttlMinutes: z
          .number()
          .int()
          .positive()
          .max(24 * 60)
          .default(30),
        maxRisk: z.enum(["safe", "recoverable", "destructive", "experimental"]).default("safe"),
      })
      .default(() => ({ ttlMinutes: 30, maxRisk: "safe" as const })),
  })
  .superRefine((config, context) => {
    const roots = new Set<string>();
    const targets: { path: string; projectIndex: number }[] = [];

    for (const [projectIndex, project] of config.artifacts.projects.entries()) {
      const root = resolve(project.root);
      if (roots.has(root)) {
        context.addIssue({
          code: "custom",
          message: "artifact project roots must be unique",
          path: ["artifacts", "projects", projectIndex, "root"],
        });
      }
      roots.add(root);
      for (const name of project.names) {
        targets.push({
          path: resolve(join(root, name)),
          projectIndex,
        });
      }
    }

    for (let left = 0; left < targets.length; left += 1) {
      for (let right = left + 1; right < targets.length; right += 1) {
        const first = targets[left]!;
        const second = targets[right]!;
        if (isInside(first.path, second.path) || isInside(second.path, first.path)) {
          context.addIssue({
            code: "custom",
            message: "artifact cleanup targets must not overlap",
            path: ["artifacts", "projects", second.projectIndex],
          });
        }
      }
    }
  });

export type AdapterId = z.infer<typeof adapterIdSchema>;
export { artifactNameSchema };
export type { ArtifactName };
export type ArtifactProject = z.infer<typeof artifactProjectSchema>;
export type Pin = z.infer<typeof pinSchema>;
export type AgentRinseConfig = z.infer<typeof agentRinseConfigSchema>;
