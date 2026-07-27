import { z } from "zod";

const copilotSessionPruneFactsSchema = z.object({
  provider: z.literal("copilot"),
  kind: z.literal("session-prune"),
  command: z.literal("/session prune --older-than <days> [--dry-run] [--include-named]"),
  localOnly: z.literal(true),
  dryRunSupported: z.literal(true),
  currentSessionExcluded: z.literal(true),
  namedSessionsExcludedByDefault: z.literal(true),
  installedSupportKnown: z.literal(false),
});

const copilotProcessLogRetentionFactsSchema = z.object({
  provider: z.literal("copilot"),
  kind: z.literal("process-log-retention"),
  introducedVersion: z.literal("1.0.52"),
  filePattern: z.literal("process-*.log"),
  maxAgeDays: z.literal(7),
  maxFiles: z.literal(50),
  extensionLogsExcluded: z.literal(true),
  installedSupportKnown: z.literal(false),
});

export const copilotNativeMaintenanceFactsSchema = z.discriminatedUnion("kind", [
  copilotSessionPruneFactsSchema,
  copilotProcessLogRetentionFactsSchema,
]);

export type CopilotNativeMaintenanceFacts = z.infer<typeof copilotNativeMaintenanceFactsSchema>;

export function copilotNativeMaintenanceFor(
  relativePath: string,
): CopilotNativeMaintenanceFacts | undefined {
  if (relativePath === "session-state") {
    return {
      provider: "copilot",
      kind: "session-prune",
      command: "/session prune --older-than <days> [--dry-run] [--include-named]",
      localOnly: true,
      dryRunSupported: true,
      currentSessionExcluded: true,
      namedSessionsExcludedByDefault: true,
      installedSupportKnown: false,
    };
  }
  if (relativePath === "logs") {
    return {
      provider: "copilot",
      kind: "process-log-retention",
      introducedVersion: "1.0.52",
      filePattern: "process-*.log",
      maxAgeDays: 7,
      maxFiles: 50,
      extensionLogsExcluded: true,
      installedSupportKnown: false,
    };
  }
  return undefined;
}
