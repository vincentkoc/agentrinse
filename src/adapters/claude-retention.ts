import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { Diagnostic } from "../contracts/diagnostic.js";

const MAX_SETTINGS_BYTES = 1024 * 1024;

export const CLAUDE_NATIVE_RETENTION_DEFAULT_DAYS = 30;

export const claudeNativeRetentionFactsSchema = z.object({
  mechanism: z.literal("cleanupPeriodDays"),
  documentedDefaultDays: z.literal(CLAUDE_NATIVE_RETENTION_DEFAULT_DAYS),
  startupSweep: z.literal(true),
  effectiveDaysKnown: z.literal(false),
  userSettingsStatus: z.enum([
    "missing",
    "valid",
    "invalid",
    "changed",
    "unreadable",
    "unsupported",
    "too-large",
  ]),
  userConfiguredDays: z.number().int().min(1).optional(),
});

export type ClaudeNativeRetentionFacts = z.infer<typeof claudeNativeRetentionFactsSchema>;

type SettingsFileHandle = Pick<FileHandle, "close" | "read" | "stat">;

export type ClaudeRetentionDependencies = {
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: number): Promise<SettingsFileHandle>;
};

export type ClaudeRetentionInspection = {
  facts: ClaudeNativeRetentionFacts;
  diagnostics: Diagnostic[];
};

const DEFAULT_DEPENDENCIES: ClaudeRetentionDependencies = {
  lstat,
  open,
};

const NATIVE_RETENTION_PATHS = new Set(["projects", "debug", "paste-cache", "image-cache"]);

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function stableStats(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.size === after.size
  );
}

async function readBoundedSettings(
  handle: SettingsFileHandle,
): Promise<{ contents?: string; overflow: boolean }> {
  const buffer = Buffer.allocUnsafe(MAX_SETTINGS_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset > MAX_SETTINGS_BYTES) {
    return { overflow: true };
  }
  return {
    contents: buffer.subarray(0, offset).toString("utf8"),
    overflow: false,
  };
}

function inspection(
  userSettingsStatus: ClaudeNativeRetentionFacts["userSettingsStatus"],
  diagnostics: Diagnostic[] = [],
  userConfiguredDays?: number,
): ClaudeRetentionInspection {
  return {
    facts: {
      mechanism: "cleanupPeriodDays",
      documentedDefaultDays: CLAUDE_NATIVE_RETENTION_DEFAULT_DAYS,
      startupSweep: true,
      effectiveDaysKnown: false,
      userSettingsStatus,
      ...(userConfiguredDays === undefined ? {} : { userConfiguredDays }),
    },
    diagnostics,
  };
}

function warning(code: string, message: string): Diagnostic {
  return {
    severity: "warning",
    code,
    message,
    adapter: "claude",
  };
}

export function usesClaudeNativeRetention(relativePath: string): boolean {
  return NATIVE_RETENTION_PATHS.has(relativePath);
}

export async function inspectClaudeNativeRetention(
  ownerRoot: string,
  platform: NodeJS.Platform = process.platform,
  dependencies: ClaudeRetentionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ClaudeRetentionInspection> {
  const settingsPath = join(ownerRoot, "settings.json");
  let entryStats: Stats;
  try {
    entryStats = await dependencies.lstat(settingsPath);
  } catch (error) {
    if (isMissing(error)) {
      return inspection("missing");
    }
    return inspection("unreadable", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_UNREADABLE",
        "Claude user settings could not be inspected; native retention is uncertain.",
      ),
    ]);
  }

  if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
    return inspection("unsupported", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_UNSUPPORTED",
        "Claude user settings are not a direct regular file; native retention is uncertain.",
      ),
    ]);
  }
  if (entryStats.size > MAX_SETTINGS_BYTES) {
    return inspection("too-large", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_TOO_LARGE",
        "Claude user settings exceed the inspection limit; native retention is uncertain.",
      ),
    ]);
  }

  let handle: SettingsFileHandle;
  try {
    const flags =
      platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await dependencies.open(settingsPath, flags);
  } catch {
    return inspection("unreadable", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_UNREADABLE",
        "Claude user settings could not be opened safely; native retention is uncertain.",
      ),
    ]);
  }

  let contents: string;
  try {
    const before = await handle.stat();
    if (!before.isFile() || !stableStats(entryStats, before) || before.size > MAX_SETTINGS_BYTES) {
      return inspection("changed", [
        warning(
          "CLAUDE_RETENTION_SETTINGS_CHANGED",
          "Claude user settings changed during inspection; native retention is uncertain.",
        ),
      ]);
    }
    const boundedRead = await readBoundedSettings(handle);
    const after = await handle.stat();
    if (!stableStats(before, after)) {
      return inspection("changed", [
        warning(
          "CLAUDE_RETENTION_SETTINGS_CHANGED",
          "Claude user settings changed during inspection; native retention is uncertain.",
        ),
      ]);
    }
    if (boundedRead.overflow || boundedRead.contents === undefined) {
      return inspection("too-large", [
        warning(
          "CLAUDE_RETENTION_SETTINGS_TOO_LARGE",
          "Claude user settings exceed the inspection limit; native retention is uncertain.",
        ),
      ]);
    }
    contents = boundedRead.contents;
  } catch {
    return inspection("unreadable", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_UNREADABLE",
        "Claude user settings could not be read safely; native retention is uncertain.",
      ),
    ]);
  } finally {
    await handle.close().catch(() => undefined);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents.replace(/^\uFEFF/u, ""));
  } catch {
    return inspection("invalid", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_INVALID",
        "Claude user settings are not valid JSON; Claude may pause its native retention sweep.",
      ),
    ]);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return inspection("invalid", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_INVALID",
        "Claude user settings must be a JSON object; Claude may pause its native retention sweep.",
      ),
    ]);
  }

  const cleanupPeriodDays = (value as Record<string, unknown>).cleanupPeriodDays;
  if (cleanupPeriodDays === undefined) {
    return inspection("valid");
  }
  if (!Number.isInteger(cleanupPeriodDays) || (cleanupPeriodDays as number) < 1) {
    return inspection("invalid", [
      warning(
        "CLAUDE_RETENTION_SETTINGS_INVALID",
        "Claude cleanupPeriodDays must be an integer of at least 1; native retention is uncertain.",
      ),
    ]);
  }
  return inspection("valid", [], cleanupPeriodDays as number);
}
