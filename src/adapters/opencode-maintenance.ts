import { z } from "zod";

const opencodeSnapshotGcFactsSchema = z.object({
  provider: z.literal("opencode"),
  kind: z.literal("snapshot-gc"),
  sourceVersion: z.literal("1.18.9"),
  pruneAgeDays: z.literal(7),
  startupDelayMinutes: z.literal(1),
  intervalHours: z.literal(1),
  snapshotsMustBeEnabled: z.literal(true),
  installedSupportKnown: z.literal(false),
});

const opencodeServerLogFactsSchema = z.object({
  provider: z.literal("opencode"),
  kind: z.literal("server-log-retention"),
  sourceVersion: z.literal("1.18.9"),
  fileName: z.literal("opencode.log"),
  writeMode: z.literal("append"),
  automaticRetention: z.literal(false),
  desktopRetentionIsSeparate: z.literal(true),
  installedSupportKnown: z.literal(false),
});

export const opencodeNativeMaintenanceFactsSchema = z.discriminatedUnion("kind", [
  opencodeSnapshotGcFactsSchema,
  opencodeServerLogFactsSchema,
]);

export type OpenCodeNativeMaintenanceFacts = z.infer<typeof opencodeNativeMaintenanceFactsSchema>;

export function opencodeNativeMaintenanceFor(
  relativePath: string,
): OpenCodeNativeMaintenanceFacts | undefined {
  if (relativePath === "snapshot") {
    return {
      provider: "opencode",
      kind: "snapshot-gc",
      sourceVersion: "1.18.9",
      pruneAgeDays: 7,
      startupDelayMinutes: 1,
      intervalHours: 1,
      snapshotsMustBeEnabled: true,
      installedSupportKnown: false,
    };
  }
  if (relativePath === "log") {
    return {
      provider: "opencode",
      kind: "server-log-retention",
      sourceVersion: "1.18.9",
      fileName: "opencode.log",
      writeMode: "append",
      automaticRetention: false,
      desktopRetentionIsSeparate: true,
      installedSupportKnown: false,
    };
  }
  return undefined;
}
