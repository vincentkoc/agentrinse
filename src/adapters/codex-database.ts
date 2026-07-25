import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  codexDatabaseFilenameSchema,
  type CodexDatabaseFilename,
  type CodexDatabaseName,
  databaseIdentitySchema,
  type DatabaseIdentity,
  type DatabaseSidecarIdentity,
} from "../contracts/action.js";
import { sha256, sha256Json } from "../core/digest.js";

const execFileAsync = promisify(execFile);
const SQLITE_SEPARATOR = "\u001f";

export type CodexDatabaseContract = {
  database: CodexDatabaseName;
  filename: CodexDatabaseFilename;
  migrationVersion: number;
  requiredTables: string[];
};

export const CODEX_DATABASE_CONTRACTS: Record<CodexDatabaseFilename, CodexDatabaseContract> = {
  "state_5.sqlite": {
    database: "state",
    filename: "state_5.sqlite",
    migrationVersion: 39,
    requiredTables: ["_sqlx_migrations", "threads"],
  },
  "logs_2.sqlite": {
    database: "logs",
    filename: "logs_2.sqlite",
    migrationVersion: 2,
    requiredTables: ["_sqlx_migrations", "logs"],
  },
  "goals_1.sqlite": {
    database: "goals",
    filename: "goals_1.sqlite",
    migrationVersion: 1,
    requiredTables: ["_sqlx_migrations", "thread_goals"],
  },
  "memories_1.sqlite": {
    database: "memories",
    filename: "memories_1.sqlite",
    migrationVersion: 1,
    requiredTables: ["_sqlx_migrations", "jobs", "stage1_outputs"],
  },
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CodexDatabaseDependencies = {
  runSqlite?: (args: string[]) => Promise<CommandResult>;
  runLsof?: (paths: string[]) => Promise<CommandResult>;
  runPs?: () => Promise<CommandResult>;
};

export type OpenHandleInspection =
  | { status: "idle"; pids: [] }
  | { status: "busy"; pids: number[] }
  | { status: "unknown"; pids: []; reason: string };

export type CodexProcessInspection =
  | { status: "idle"; pids: [] }
  | { status: "busy"; pids: number[] }
  | { status: "unknown"; pids: []; reason: string };

export type CodexDatabaseInspection = {
  identity: DatabaseIdentity;
  estimatedReclaimBytes: number;
  freePageRatio: number;
  quickCheck: "ok";
  walBytes: number;
  shmBytes: number;
  sidecarsPresent: boolean;
};

function commandError(error: unknown): CommandResult & { code?: string | number } {
  const value = error as {
    code?: string | number;
    stdout?: string;
    stderr?: string;
  };
  return {
    ...(value.code === undefined ? {} : { code: value.code }),
    stdout: value.stdout ?? "",
    stderr: value.stderr ?? (error instanceof Error ? error.message : String(error)),
  };
}

async function defaultSqliteRunner(args: string[]): Promise<CommandResult> {
  const result = await execFileAsync("sqlite3", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function querySqlite(
  path: string,
  sql: string,
  dependencies: CodexDatabaseDependencies,
): Promise<string[]> {
  const result = await (dependencies.runSqlite ?? defaultSqliteRunner)([
    "-batch",
    "-readonly",
    "-noheader",
    "-separator",
    SQLITE_SEPARATOR,
    "-cmd",
    ".timeout 1000",
    `${pathToFileURL(path).href}?immutable=1`,
    sql,
  ]);
  if (result.stderr.trim() !== "") {
    throw new Error(`sqlite3 could not inspect ${path}: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function optionalFile(path: string): Promise<DatabaseSidecarIdentity | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`SQLite sidecar is not a regular file: ${path}`);
    }
    return {
      path,
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      measuredBytes: stats.size,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function parseInteger(value: string | undefined, label: string): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`SQLite returned an invalid ${label}: ${value ?? "<missing>"}`);
  }
  return parsed;
}

export function codexDatabaseContract(path: string): CodexDatabaseContract | undefined {
  const filename = codexDatabaseFilenameSchema.safeParse(basename(path));
  return filename.success ? CODEX_DATABASE_CONTRACTS[filename.data] : undefined;
}

export async function inspectCodexDatabase(
  path: string,
  dependencies: CodexDatabaseDependencies = {},
  contractPath: string = path,
): Promise<CodexDatabaseInspection> {
  const contract = codexDatabaseContract(contractPath);
  if (contract === undefined) {
    throw new Error(`unsupported Codex database filename: ${basename(path)}`);
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Codex database is not a regular file: ${path}`);
  }

  const values = await querySqlite(
    path,
    [
      "PRAGMA query_only=ON;",
      "SELECT page_size FROM pragma_page_size;",
      "SELECT page_count FROM pragma_page_count;",
      "SELECT freelist_count FROM pragma_freelist_count;",
      "SELECT auto_vacuum FROM pragma_auto_vacuum;",
      "PRAGMA quick_check;",
    ].join(" "),
    dependencies,
  );
  if (values[4] !== "ok") {
    throw new Error(`Codex database quick check failed: ${values.slice(4).join("; ")}`);
  }

  const tables = await querySqlite(
    path,
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;",
    dependencies,
  );
  const migrationVersion = tables.includes("_sqlx_migrations")
    ? parseInteger(
        (
          await querySqlite(
            path,
            "SELECT coalesce(max(version), 0) FROM _sqlx_migrations WHERE success = 1;",
            dependencies,
          )
        )[0],
        "migration version",
      )
    : 0;
  const schemaRows = await querySqlite(
    path,
    "SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_schema ORDER BY type, name;",
    dependencies,
  );
  const pageSize = parseInteger(values[0], "page size");
  const pageCount = parseInteger(values[1], "page count");
  const freelistCount = parseInteger(values[2], "freelist count");
  const autoVacuum = parseInteger(values[3], "auto-vacuum mode");
  const wal = await optionalFile(`${path}-wal`);
  const shm = await optionalFile(`${path}-shm`);
  const identity = databaseIdentitySchema.parse({
    path,
    database: contract.database,
    filename: contract.filename,
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    mtimeMs: stats.mtimeMs,
    measuredBytes: stats.size,
    pageSize,
    pageCount,
    freelistCount,
    autoVacuum,
    migrationVersion,
    tables,
    ...(wal === undefined ? {} : { wal }),
    ...(shm === undefined ? {} : { shm }),
    schemaDigest: sha256(schemaRows.join("\n")),
    fingerprint: sha256Json({
      path,
      database: contract.database,
      filename: contract.filename,
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      mtimeMs: stats.mtimeMs,
      measuredBytes: stats.size,
      pageSize,
      pageCount,
      freelistCount,
      autoVacuum,
      migrationVersion,
      tables,
      wal,
      shm,
      schemaRows,
    }),
  });
  return {
    identity,
    estimatedReclaimBytes: pageSize * freelistCount,
    freePageRatio: pageCount === 0 ? 0 : freelistCount / pageCount,
    quickCheck: "ok",
    walBytes: wal?.measuredBytes ?? 0,
    shmBytes: shm?.measuredBytes ?? 0,
    sidecarsPresent: wal !== undefined || shm !== undefined,
  };
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function vacuumCodexDatabaseInto(
  sourcePath: string,
  destinationPath: string,
  dependencies: CodexDatabaseDependencies = {},
): Promise<void> {
  const result = await (dependencies.runSqlite ?? defaultSqliteRunner)([
    "-batch",
    "-readonly",
    "-cmd",
    ".timeout 1000",
    `${pathToFileURL(sourcePath).href}?immutable=1`,
    `VACUUM INTO ${sqliteString(destinationPath)};`,
  ]);
  if (result.stderr.trim() !== "") {
    throw new Error(`sqlite3 VACUUM INTO failed: ${result.stderr.trim()}`);
  }
  const normalize = await (dependencies.runSqlite ?? defaultSqliteRunner)([
    "-batch",
    "-cmd",
    ".timeout 1000",
    destinationPath,
    "PRAGMA synchronous=FULL; PRAGMA auto_vacuum=INCREMENTAL; VACUUM;",
  ]);
  if (normalize.stderr.trim() !== "") {
    throw new Error(
      `sqlite3 could not enable incremental auto-vacuum on the compacted copy: ${normalize.stderr.trim()}`,
    );
  }
}

export async function verifyCodexDatabaseIntegrity(
  path: string,
  dependencies: CodexDatabaseDependencies = {},
): Promise<void> {
  const result = await querySqlite(path, "PRAGMA integrity_check;", dependencies);
  if (result.length !== 1 || result[0] !== "ok") {
    throw new Error(`Codex database integrity check failed: ${result.join("; ")}`);
  }
}

async function defaultLsofRunner(paths: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync("lsof", ["-nP", "-Fpcfn", "--", ...paths], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = commandError(error);
    if (Number(value.code) === 1 && value.stdout === "" && value.stderr === "") {
      return { stdout: "", stderr: "" };
    }
    throw error;
  }
}

export async function inspectDatabaseOpenHandles(
  path: string,
  dependencies: CodexDatabaseDependencies = {},
): Promise<OpenHandleInspection> {
  if (!["darwin", "linux"].includes(process.platform) && dependencies.runLsof === undefined) {
    return {
      status: "unknown",
      pids: [],
      reason: `open-file inspection is unsupported on ${process.platform}`,
    };
  }
  try {
    const paths = (
      await Promise.all(
        [path, `${path}-wal`, `${path}-shm`].map(async (candidate) => {
          try {
            await lstat(candidate);
            return candidate;
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              return undefined;
            }
            throw error;
          }
        }),
      )
    ).filter((candidate): candidate is string => candidate !== undefined);
    if (paths.length === 0) {
      return { status: "idle", pids: [] };
    }
    const result = await (dependencies.runLsof ?? defaultLsofRunner)(paths);
    if (result.stderr.trim() !== "") {
      return {
        status: "unknown",
        pids: [],
        reason: `lsof reported an incomplete scan: ${result.stderr.trim()}`,
      };
    }
    const pids = [
      ...new Set(
        result.stdout
          .split("\n")
          .filter((line) => /^p\d+$/u.test(line))
          .map((line) => Number.parseInt(line.slice(1), 10)),
      ),
    ].sort((left, right) => left - right);
    return pids.length === 0 ? { status: "idle", pids: [] } : { status: "busy", pids };
  } catch (error) {
    return {
      status: "unknown",
      pids: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function defaultPsRunner(): Promise<CommandResult> {
  const result = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isCodexProcess(command: string): boolean {
  return (
    /(?:^|\/)Codex\.app(?:\/|$)/u.test(command) ||
    /(?:^|\s|\/)codex(?:\s|$)/u.test(command) ||
    /(?:^|\s|\/)codex-cli(?:\s|$)/u.test(command) ||
    /(?:^|\s)app-server(?:\s|$)/u.test(command)
  );
}

export async function inspectCodexProcesses(
  dependencies: CodexDatabaseDependencies = {},
): Promise<CodexProcessInspection> {
  if (!["darwin", "linux"].includes(process.platform) && dependencies.runPs === undefined) {
    return {
      status: "unknown",
      pids: [],
      reason: `Codex process inspection is unsupported on ${process.platform}`,
    };
  }
  try {
    const result = await (dependencies.runPs ?? defaultPsRunner)();
    if (result.stderr.trim() !== "") {
      return {
        status: "unknown",
        pids: [],
        reason: `ps reported an incomplete scan: ${result.stderr.trim()}`,
      };
    }
    const pids = result.stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null && isCodexProcess(match[2]!))
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((pid) => pid !== process.pid)
      .sort((left, right) => left - right);
    return pids.length === 0 ? { status: "idle", pids: [] } : { status: "busy", pids };
  } catch (error) {
    return {
      status: "unknown",
      pids: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function codexDatabaseContractMatches(identity: DatabaseIdentity): boolean {
  const contract = CODEX_DATABASE_CONTRACTS[identity.filename];
  return (
    identity.database === contract.database &&
    identity.migrationVersion === contract.migrationVersion &&
    contract.requiredTables.every((table) => identity.tables.includes(table))
  );
}
