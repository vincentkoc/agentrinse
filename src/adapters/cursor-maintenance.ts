import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const cursorOwnerCommandSchema = z.object({
  command: z.string().min(1),
  interface: z.literal("command-palette"),
  destructive: z.boolean(),
  runsVacuum: z.literal(true),
});

export const cursorNativeMaintenanceFactsSchema = z.object({
  provider: z.literal("cursor"),
  kind: z.literal("database-maintenance"),
  evidenceDate: z.literal("2026-07-13"),
  automaticRetention: z.literal(false),
  installedSupportKnown: z.literal(false),
  commands: z.tuple([
    cursorOwnerCommandSchema.extend({
      command: z.literal("Developer: GC Agent KV Blobs"),
      destructive: z.literal(false),
      scope: z.literal("orphaned-agent-kv-blobs"),
      preservesExistingChats: z.literal(true),
    }),
    cursorOwnerCommandSchema.extend({
      command: z.literal("Developer: Delete Old Chats..."),
      destructive: z.literal(true),
      scope: z.literal("chat-history-by-age"),
      userChoosesCutoff: z.literal(true),
    }),
  ]),
});

export type CursorNativeMaintenanceFacts = z.infer<typeof cursorNativeMaintenanceFactsSchema>;

const cursorDatabaseCompanionSchema = z.object({
  suffix: z.enum([".backup", "-wal", "-shm"]),
  status: z.enum(["missing", "regular", "symlink", "other", "unknown"]),
  measuredBytes: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).optional(),
});

export const cursorDatabaseCompanionsSchema = z.array(cursorDatabaseCompanionSchema).length(3);

export type CursorDatabaseCompanions = z.infer<typeof cursorDatabaseCompanionsSchema>;

export type CursorDatabaseParentInspection =
  | { status: "safe" }
  | { status: "missing" }
  | { status: "blocked"; code: "symlink" | "not-directory" | "unreadable"; reason: string };

function relativePathParts(relativePath: string): string[] {
  return relativePath.split(/[\\/]+/u).filter(Boolean);
}

export function cursorNativeMaintenanceFor(
  relativePath: string,
): CursorNativeMaintenanceFacts | undefined {
  if (relativePathParts(relativePath).join("/") !== "User/globalStorage/state.vscdb") {
    return undefined;
  }
  return {
    provider: "cursor",
    kind: "database-maintenance",
    evidenceDate: "2026-07-13",
    automaticRetention: false,
    installedSupportKnown: false,
    commands: [
      {
        command: "Developer: GC Agent KV Blobs",
        interface: "command-palette",
        destructive: false,
        runsVacuum: true,
        scope: "orphaned-agent-kv-blobs",
        preservesExistingChats: true,
      },
      {
        command: "Developer: Delete Old Chats...",
        interface: "command-palette",
        destructive: true,
        runsVacuum: true,
        scope: "chat-history-by-age",
        userChoosesCutoff: true,
      },
    ],
  };
}

export async function inspectCursorDatabaseParents(
  ownerRoot: string,
  relativePath: string,
): Promise<CursorDatabaseParentInspection> {
  const parents = relativePathParts(relativePath).slice(0, -1);
  let current = ownerRoot;
  for (const part of parents) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        return {
          status: "blocked",
          code: "symlink",
          reason: "A Cursor database parent directory is a symlink.",
        };
      }
      if (!stats.isDirectory()) {
        return {
          status: "blocked",
          code: "not-directory",
          reason: "A Cursor database parent path is not a directory.",
        };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { status: "missing" };
      }
      return {
        status: "blocked",
        code: "unreadable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { status: "safe" };
}

export async function inspectCursorDatabaseCompanions(
  databasePath: string,
  measureBytes: boolean,
): Promise<CursorDatabaseCompanions> {
  return Promise.all(
    ([".backup", "-wal", "-shm"] as const).map(async (suffix) => {
      try {
        const stats = await lstat(`${databasePath}${suffix}`);
        if (stats.isSymbolicLink()) {
          return { suffix, status: "symlink" as const };
        }
        if (!stats.isFile()) {
          return { suffix, status: "other" as const };
        }
        return {
          suffix,
          status: "regular" as const,
          ...(measureBytes ? { measuredBytes: stats.size } : {}),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          return { suffix, status: "missing" as const };
        }
        return {
          suffix,
          status: "unknown" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
