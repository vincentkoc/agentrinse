import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "../core/digest.js";

export type OpenClawWorktree = {
  id: string;
  repoRoot: string;
  path: string;
  owner: string;
  removed: boolean;
  hasSnapshot: boolean;
};

const supportedSchemaVersions = { agent: [38, 42], global: [36, 40] };

type Inspection =
  | { status: "uncheckpointed" | "unsupported" | "changed" | "unreadable" }
  | {
      status: "observed";
      schemaVersion: number;
      truncated: boolean;
      counts: Record<string, number>;
      worktrees: OpenClawWorktree[];
      sessions: { id: string; archived: boolean; pinned: boolean; running: boolean }[];
    };

async function fileStamp(path: string): Promise<string | undefined> {
  try {
    const st = await lstat(path, { bigint: true });
    if (!st.isFile()) throw new Error("Expected a regular file");
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function hasOpenClawJournal(path: string): Promise<boolean> {
  for (const suffix of ["-wal", "-journal"]) {
    try {
      const stats = await lstat(path + suffix);
      if (!stats.isFile() || stats.size !== 0) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

// Only fixed queries against the owner's ordinary STRICT tables. Never project
// entry JSON, message bodies, authentication columns or embedding payloads.
function inspectTables(db: DatabaseSync, role: "agent" | "global", limit: number): Inspection {
  const tables =
    role === "agent"
      ? [
          "schema_meta",
          "session_nodes",
          "transcript_events",
          "memory_index_sources",
          "memory_embedding_cache",
        ]
      : ["schema_meta", "worktrees"];
  const ordinary = db.prepare(
    "SELECT 1 FROM pragma_table_list WHERE schema='main' AND name=? AND type='table' AND strict=1",
  );
  if (!tables.every((name) => ordinary.get(name))) return { status: "unsupported" };
  const schemaVersion = db
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary' AND role=?")
    .get(role)?.schema_version;
  if (typeof schemaVersion !== "number" || !supportedSchemaVersions[role].includes(schemaVersion)) {
    return { status: "unsupported" };
  }

  const counts: Record<string, number> = {};
  let truncated = false;
  const worktrees: OpenClawWorktree[] = [];
  const sessions: Extract<Inspection, { status: "observed" }>["sessions"] = [];
  if (role === "agent") {
    const rows = db
      .prepare(
        "SELECT substr(session_key,1,4097) AS session_key, archived_at IS NOT NULL AS archived, pinned_at IS NOT NULL AS pinned, status='running' AS running FROM session_nodes LIMIT ?",
      )
      .all(limit + 1);
    for (const row of rows.slice(0, limit)) {
      if (typeof row.session_key !== "string" || !row.session_key || row.session_key.length > 4096)
        return { status: "unsupported" };
      sessions.push({
        id: sha256(row.session_key),
        archived: row.archived === 1,
        pinned: row.pinned === 1,
        running: row.running === 1,
      });
    }
    truncated = rows.length > limit;
    counts.sessionRows = sessions.length;
    counts.archivedSessions = sessions.filter((s) => s.archived).length;
    counts.pinnedSessions = sessions.filter((s) => s.pinned).length;
    counts.runningSessions = sessions.filter((s) => s.running).length;
    for (const [key, table] of [
      ["transcriptEvents", "transcript_events"],
      ["memorySources", "memory_index_sources"],
      ["embeddingCacheEntries", "memory_embedding_cache"],
    ] as const) {
      const count = Number(
        db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ?)`).get(limit + 1)?.n,
      );
      counts[key] = Math.min(count, limit);
      truncated ||= count > limit;
    }
  } else {
    const rows = db
      .prepare(
        "SELECT substr(id,1,129) AS id, substr(path,1,4097) AS path, substr(repo_root,1,4097) AS repo_root, owner_kind, removed_at IS NOT NULL AS removed, snapshot_ref IS NOT NULL AS snapshot FROM worktrees LIMIT ?",
      )
      .all(limit + 1);
    truncated = rows.length > limit;
    for (const row of rows.slice(0, limit)) {
      if (
        !validOwnerPath(row.path) ||
        !validOwnerPath(row.repo_root) ||
        !["session", "manual", "workboard"].includes(String(row.owner_kind))
      ) {
        return { status: "unsupported" };
      }
      if (typeof row.id !== "string" || !row.id || row.id.length > 128)
        return { status: "unsupported" };
      worktrees.push({
        id: row.id,
        path: row.path,
        repoRoot: row.repo_root,
        owner: String(row.owner_kind),
        removed: row.removed === 1,
        hasSnapshot: row.snapshot === 1,
      });
    }
    counts.registeredWorktrees = worktrees.length;
  }
  return { status: "observed", schemaVersion, truncated, counts, worktrees, sessions };
}

function validOwnerPath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value)
  );
}

export async function inspectOpenClawDatabase(
  path: string,
  role: "agent" | "global",
  maxEntries: number,
): Promise<Inspection> {
  try {
    const before = await fileStamp(path);
    if (before === undefined || (await realpath(path)) !== path) return { status: "changed" };
    if (await hasOpenClawJournal(path)) return { status: "uncheckpointed" };
    // SQLite immutable mode never creates WAL/SHM files or locks the active owner.
    // It ignores journals, so never present its rows when a journal could matter.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(pathToFileURL(path).href + "?mode=ro&immutable=1", {
      readOnly: true,
      allowExtension: false,
    });
    let inspection: Inspection;
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
      inspection = inspectTables(db, role, Math.min(4096, maxEntries));
    } finally {
      db.close();
    }
    if (
      (await hasOpenClawJournal(path)) ||
      (await fileStamp(path)) !== before ||
      (await realpath(path)) !== path
    ) {
      return { status: "changed" };
    }
    return inspection;
  } catch {
    return { status: "unreadable" };
  }
}
