import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
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
const SQLITE_INSPECTION_TIMEOUT_MS = 30_000;
const SQLITE_INTEGRITY_TIMEOUT_MS = 30 * 60_000;
const SQLITE_MAINTENANCE_TIMEOUT_MS = 2 * 60 * 60_000;

export type CodexDatabaseContract = {
  database: CodexDatabaseName;
  filename: CodexDatabaseFilename;
  migrationVersion: number;
  migrationDigest: string;
  schemaDigest: string;
  requiredTables: string[];
};

export const CODEX_DATABASE_CONTRACTS: Record<CodexDatabaseFilename, CodexDatabaseContract> = {
  "state_5.sqlite": {
    database: "state",
    filename: "state_5.sqlite",
    migrationVersion: 39,
    migrationDigest: "e58f1d744ab8979fe6b48ae235fcc18474f72979523d90e8b8104555a05d9a7c",
    schemaDigest: "0ccab9d0c01ff5f9d3ea65c477892611176d9c8b707d2245c08646da13fc09a0",
    requiredTables: ["_sqlx_migrations", "threads"],
  },
  "logs_2.sqlite": {
    database: "logs",
    filename: "logs_2.sqlite",
    migrationVersion: 2,
    migrationDigest: "c05a0bee9a9eb893e6d79f9b173fdd3de36f0233f60410dbce924a4080f7be40",
    schemaDigest: "7dbaeea373d1b81fe583529e6efaa18345c20e4e4639702bf3c2d54f82883874",
    requiredTables: ["_sqlx_migrations", "logs"],
  },
  "goals_1.sqlite": {
    database: "goals",
    filename: "goals_1.sqlite",
    migrationVersion: 1,
    migrationDigest: "8ce3d311cf69af8f56b0722d617df5552b8ef863a4f60bfe5ba3bf76e30c8f05",
    schemaDigest: "1e4b7b279b41ddb11bfd6162ea6c1258f42f07a24e9bb4ca8b0148bfa865e8c0",
    requiredTables: ["_sqlx_migrations", "thread_goals"],
  },
  "memories_1.sqlite": {
    database: "memories",
    filename: "memories_1.sqlite",
    migrationVersion: 1,
    migrationDigest: "580d14eff9340381a3e5ccd7db0156a91649f7466e8e697a2d5d3098bdef1930",
    schemaDigest: "90be68fa20a2cce1a3cb9eff8058d752eaca624a07ab0a17c1244f4b0b6eed8b",
    requiredTables: ["_sqlx_migrations", "jobs", "stage1_outputs"],
  },
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type SqliteRunOptions = {
  timeoutMs: number;
};

export type CodexDatabaseDependencies = {
  runSqlite?: (args: string[], options?: SqliteRunOptions) => Promise<CommandResult>;
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

async function defaultSqliteRunner(
  args: string[],
  options: SqliteRunOptions = { timeoutMs: SQLITE_INSPECTION_TIMEOUT_MS },
): Promise<CommandResult> {
  const result = await execFileAsync("sqlite3", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function querySqlite(
  path: string,
  sql: string,
  dependencies: CodexDatabaseDependencies,
  timeoutMs = SQLITE_INSPECTION_TIMEOUT_MS,
): Promise<string[]> {
  const result = await (dependencies.runSqlite ?? defaultSqliteRunner)(
    [
      "-batch",
      "-readonly",
      "-noheader",
      "-separator",
      SQLITE_SEPARATOR,
      "-cmd",
      ".timeout 1000",
      `${pathToFileURL(path).href}?immutable=1`,
      sql,
    ],
    { timeoutMs },
  );
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

async function readSqliteJournalMode(path: string): Promise<"wal"> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString("binary", 0, 16) !== "SQLite format 3\0") {
      throw new Error(`Codex database has an invalid SQLite header: ${path}`);
    }
    if (header[18] !== 2 || header[19] !== 2) {
      throw new Error(`Codex database journal mode is not persistent WAL: ${path}`);
    }
    return "wal";
  } finally {
    await handle.close();
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
  identityPath: string = path,
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
  const migrationRows = tables.includes("_sqlx_migrations")
    ? await (async () => {
        const failedMigrations = parseInteger(
          (
            await querySqlite(
              path,
              "SELECT count(*) FROM _sqlx_migrations WHERE success != 1;",
              dependencies,
            )
          )[0],
          "failed migration count",
        );
        if (failedMigrations !== 0) {
          throw new Error(`Codex database contains ${failedMigrations} failed SQLx migration(s)`);
        }
        return querySqlite(
          path,
          "SELECT version, description, lower(hex(checksum)) FROM _sqlx_migrations ORDER BY version;",
          dependencies,
        );
      })()
    : [];
  const migrationVersion =
    migrationRows.length === 0
      ? 0
      : parseInteger(migrationRows.at(-1)?.split(SQLITE_SEPARATOR)[0], "migration version");
  const migrationDigest = sha256(migrationRows.join("\n"));
  const schemaRows = await querySqlite(
    path,
    "SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_schema ORDER BY type, name;",
    dependencies,
  );
  const pageSize = parseInteger(values[0], "page size");
  const pageCount = parseInteger(values[1], "page count");
  const freelistCount = parseInteger(values[2], "freelist count");
  const autoVacuum = parseInteger(values[3], "auto-vacuum mode");
  const journalMode = await readSqliteJournalMode(path);
  const wal = await optionalFile(`${path}-wal`);
  const shm = await optionalFile(`${path}-shm`);
  const identity = databaseIdentitySchema.parse({
    path: identityPath,
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
    journalMode,
    autoVacuum,
    migrationVersion,
    migrationDigest,
    tables,
    ...(wal === undefined ? {} : { wal }),
    ...(shm === undefined ? {} : { shm }),
    schemaDigest: sha256(schemaRows.join("\n")),
    fingerprint: sha256Json({
      path: identityPath,
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
      journalMode,
      autoVacuum,
      migrationVersion,
      migrationDigest,
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
  const result = await (dependencies.runSqlite ?? defaultSqliteRunner)(
    [
      "-batch",
      "-readonly",
      "-cmd",
      ".timeout 1000",
      `${pathToFileURL(sourcePath).href}?immutable=1`,
      `VACUUM INTO ${sqliteString(destinationPath)};`,
    ],
    { timeoutMs: SQLITE_MAINTENANCE_TIMEOUT_MS },
  );
  if (result.stderr.trim() !== "") {
    throw new Error(`sqlite3 VACUUM INTO failed: ${result.stderr.trim()}`);
  }
  const normalize = await (dependencies.runSqlite ?? defaultSqliteRunner)(
    [
      "-batch",
      "-cmd",
      ".timeout 1000",
      destinationPath,
      "PRAGMA synchronous=FULL; PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA journal_mode=WAL;",
    ],
    { timeoutMs: SQLITE_MAINTENANCE_TIMEOUT_MS },
  );
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
  const result = await querySqlite(
    path,
    "PRAGMA integrity_check;",
    dependencies,
    SQLITE_INTEGRITY_TIMEOUT_MS,
  );
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
    identity.migrationDigest === contract.migrationDigest &&
    identity.schemaDigest === contract.schemaDigest &&
    contract.requiredTables.every((table) => identity.tables.includes(table))
  );
}
