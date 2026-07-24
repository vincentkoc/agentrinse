import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { AuditContext } from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import { sha256 } from "../core/digest.js";
import type { ReachabilityIndex } from "../core/reachability.js";
import type { ProviderAdapterId } from "./provider-specs.js";

type JsonObject = Record<string, unknown>;

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(adapter: ProviderAdapterId, code: string, message: string): Diagnostic {
  return {
    severity: "warning",
    code,
    message,
    adapter,
  };
}

async function readMetadataObject(
  path: string,
): Promise<
  | { status: "absent" }
  | { status: "invalid"; message: string }
  | { status: "available"; value: JsonObject }
> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return { status: "invalid", message: "Metadata symlinks are not followed." };
    }
    if (!stats.isFile()) {
      return { status: "invalid", message: "Metadata path is not a regular file." };
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isObject(value)
      ? { status: "available", value }
      : { status: "invalid", message: "Metadata root must be a JSON object." };
  } catch (error) {
    if (isMissing(error)) {
      return { status: "absent" };
    }
    return {
      status: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function addPathRoot(
  index: ReachabilityIndex,
  input: {
    path: string;
    code: string;
    source: ProviderAdapterId;
    detail: string;
    field: string;
    scope?: "exact" | "subtree";
  },
): boolean {
  if (!isAbsolute(input.path)) {
    return false;
  }
  const path = resolve(input.path);
  index.add({
    path,
    code: input.code,
    source: input.source,
    detail: input.detail,
    evidenceRef: sha256(`${input.source}\0${input.field}\0${path}`),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  });
  return true;
}

async function addManagedRoot(
  adapter: ProviderAdapterId,
  root: string,
  index: ReachabilityIndex,
): Promise<Diagnostic[]> {
  const worktrees = join(root, "worktrees");
  try {
    const stats = await lstat(worktrees);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      index.addGlobal({
        code: "unknown-provider-state",
        source: adapter,
        detail: `${adapter} managed worktree ownership could not be proven.`,
      });
      return [
        diagnostic(
          adapter,
          "PROVIDER_WORKTREE_ROOT_UNSAFE",
          "The managed worktree root must be a real directory.",
        ),
      ];
    }
    addPathRoot(index, {
      path: worktrees,
      code: "provider-managed-worktree",
      source: adapter,
      detail: `${adapter} owns this managed worktree.`,
      field: "worktrees",
      scope: "subtree",
    });
    return [];
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    index.addGlobal({
      code: "unknown-provider-state",
      source: adapter,
      detail: `${adapter} managed worktree ownership could not be proven.`,
    });
    return [
      diagnostic(
        adapter,
        "PROVIDER_WORKTREE_ROOT_UNREADABLE",
        error instanceof Error ? error.message : String(error),
      ),
    ];
  }
}

function parsePathArray(
  value: unknown,
  add: (path: string) => void,
): "absent" | "valid" | "invalid" {
  if (value === undefined) {
    return "absent";
  }
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) {
    return "invalid";
  }
  for (const path of value) {
    add(path as string);
  }
  return "valid";
}

function parsePathRecord(
  value: unknown,
  add: (path: string) => void,
): "absent" | "valid" | "invalid" {
  if (value === undefined) {
    return "absent";
  }
  if (!isObject(value) || Object.values(value).some((path) => typeof path !== "string")) {
    return "invalid";
  }
  for (const path of Object.values(value)) {
    add(path as string);
  }
  return "valid";
}

async function collectCodexReachability(
  root: string,
  index: ReachabilityIndex,
): Promise<Diagnostic[]> {
  const diagnostics = await addManagedRoot("codex", root, index);
  const metadata = await readMetadataObject(join(root, ".codex-global-state.json"));
  if (metadata.status !== "available") {
    index.addGlobal({
      code: "unknown-provider-state",
      source: "codex",
      detail: "Codex workspace metadata could not be proven.",
    });
    diagnostics.push(
      diagnostic(
        "codex",
        metadata.status === "absent"
          ? "CODEX_WORKSPACE_METADATA_MISSING"
          : "CODEX_WORKSPACE_METADATA_INVALID",
        metadata.status === "absent"
          ? "Codex workspace metadata is unavailable."
          : metadata.message,
      ),
    );
    return diagnostics;
  }

  let invalidPath = false;
  const add = (code: string, detail: string, field: string) => (path: string) => {
    if (!addPathRoot(index, { path, code, source: "codex", detail, field })) {
      invalidPath = true;
    }
  };
  const fieldStates = [
    parsePathArray(
      metadata.value["active-workspace-roots"],
      add("active-session", "Codex marks this workspace as active.", "active-workspace-roots"),
    ),
    parsePathArray(
      metadata.value["electron-saved-workspace-roots"],
      add(
        "recent-session",
        "Codex retains this saved workspace.",
        "electron-saved-workspace-roots",
      ),
    ),
    parsePathRecord(
      metadata.value["thread-workspace-root-hints"],
      add(
        "recent-session",
        "Codex thread metadata references this workspace.",
        "thread-workspace-root-hints",
      ),
    ),
  ];

  if (
    invalidPath ||
    fieldStates.includes("invalid") ||
    fieldStates.every((state) => state === "absent")
  ) {
    index.addGlobal({
      code: "unknown-provider-state",
      source: "codex",
      detail: "Codex workspace metadata is unsupported or incomplete.",
    });
    diagnostics.push(
      diagnostic(
        "codex",
        "CODEX_WORKSPACE_METADATA_UNSUPPORTED",
        "Codex workspace metadata contains unsupported path fields.",
      ),
    );
  }
  return diagnostics;
}

async function collectClaudeReachability(
  context: AuditContext,
  root: string,
  index: ReachabilityIndex,
): Promise<Diagnostic[]> {
  const diagnostics = await addManagedRoot("claude", root, index);
  const metadata = await readMetadataObject(join(context.home, ".claude.json"));
  if (metadata.status !== "available" || !isObject(metadata.value.projects)) {
    index.addGlobal({
      code: "unknown-provider-state",
      source: "claude",
      detail: "Claude project metadata could not be proven.",
    });
    diagnostics.push(
      diagnostic(
        "claude",
        metadata.status === "absent"
          ? "CLAUDE_PROJECT_METADATA_MISSING"
          : "CLAUDE_PROJECT_METADATA_INVALID",
        metadata.status === "available"
          ? "Claude project metadata must contain a projects object."
          : metadata.status === "absent"
            ? "Claude project metadata is unavailable."
            : metadata.message,
      ),
    );
    return diagnostics;
  }

  let invalidPath = false;
  for (const path of Object.keys(metadata.value.projects)) {
    if (
      !addPathRoot(index, {
        path,
        code: "recent-session",
        source: "claude",
        detail: "Claude project metadata references this workspace.",
        field: "projects",
      })
    ) {
      invalidPath = true;
    }
  }
  if (invalidPath) {
    index.addGlobal({
      code: "unknown-provider-state",
      source: "claude",
      detail: "Claude project metadata contains unsupported workspace paths.",
    });
    diagnostics.push(
      diagnostic(
        "claude",
        "CLAUDE_PROJECT_METADATA_UNSUPPORTED",
        "Claude project metadata contains non-absolute workspace paths.",
      ),
    );
  }
  return diagnostics;
}

export async function collectProviderReachability(
  adapter: ProviderAdapterId,
  context: AuditContext,
  root: string,
  index: ReachabilityIndex,
): Promise<Diagnostic[]> {
  if (adapter === "codex") {
    return collectCodexReachability(root, index);
  }
  if (adapter === "claude") {
    return collectClaudeReachability(context, root, index);
  }
  return [];
}
