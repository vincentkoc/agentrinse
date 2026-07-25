import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { DatabaseIdentity, DatabaseVacuumAction } from "../../src/contracts/action.js";
import { databaseBackupEntrySchema } from "../../src/contracts/database-backup.js";
import { executeDatabaseVacuum } from "../../src/core/database-executor.js";
import { purgeDatabaseBackup, undoDatabaseVacuum } from "../../src/core/database-recovery.js";
import { readJsonFile } from "../../src/state/json-file.js";
import { inspectCodexDatabase } from "../../src/adapters/codex-database.js";

const execFileAsync = promisify(execFile);
const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function identity(path: string, content: "original" | "compacted"): DatabaseIdentity {
  return {
    path,
    database: "state",
    filename: "state_5.sqlite",
    device: 1,
    inode: content === "original" ? 10 : 11,
    mode: 0o100600,
    mtimeMs: content === "original" ? 100 : 200,
    measuredBytes: content === "original" ? 1024 : 256,
    pageSize: 4096,
    pageCount: content === "original" ? 4 : 1,
    freelistCount: content === "original" ? 3 : 0,
    autoVacuum: content === "original" ? 0 : 2,
    migrationVersion: 39,
    tables: ["_sqlx_migrations", "threads"],
    schemaDigest: "a".repeat(64),
    fingerprint: (content === "original" ? "b" : "c").repeat(64),
  };
}

function action(path: string): DatabaseVacuumAction {
  return {
    actionId: "database.vacuum:fixture",
    type: "database.vacuum",
    adapter: "codex",
    resourceId: "codex:agent-database:fixture",
    risk: "experimental",
    description: "Compact synthetic Codex state database",
    expectedReclaimBytes: 768,
    backupTtlMinutes: 60,
    target: identity(path, "original"),
  };
}

function dependencies() {
  return {
    clock: () => new Date("2026-07-25T00:00:00.000Z"),
    inspectProcesses: async () => ({ status: "idle" as const, pids: [] as [] }),
    inspectOpenHandles: async () => ({ status: "idle" as const, pids: [] as [] }),
    verifyIntegrity: async () => undefined,
    vacuumInto: async (_source: string, destination: string) => {
      await writeFile(destination, "compacted");
    },
    inspectDatabase: async (path: string) => {
      const content = (await readFile(path, "utf8")) as "original" | "compacted";
      const sidecars = await Promise.all(
        (["wal", "shm"] as const).map(async (suffix) => {
          const sidecarPath = `${path}-${suffix}`;
          try {
            const stats = await lstat(sidecarPath);
            return {
              suffix,
              identity: {
                path: sidecarPath,
                device: stats.dev,
                inode: stats.ino,
                mode: stats.mode,
                mtimeMs: stats.mtimeMs,
                measuredBytes: stats.size,
              },
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
        }),
      );
      const wal = sidecars.find((sidecar) => sidecar?.suffix === "wal")?.identity;
      const shm = sidecars.find((sidecar) => sidecar?.suffix === "shm")?.identity;
      return {
        identity: {
          ...identity(path, content),
          ...(wal === undefined ? {} : { wal }),
          ...(shm === undefined ? {} : { shm }),
        },
        estimatedReclaimBytes: content === "original" ? 768 : 0,
        freePageRatio: content === "original" ? 0.75 : 0,
        quickCheck: "ok" as const,
        walBytes: wal?.measuredBytes ?? 0,
        shmBytes: shm?.measuredBytes ?? 0,
        sidecarsPresent: wal !== undefined || shm !== undefined,
      };
    },
  };
}

describe("database vacuum execution and recovery", () => {
  it.runIf(hasSqlite)("compacts and restores a real synthetic SQLite state database", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-sqlite-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await execFileAsync("sqlite3", [
      originalPath,
      [
        "PRAGMA journal_mode=WAL;",
        "CREATE TABLE _sqlx_migrations(version INTEGER NOT NULL, success INTEGER NOT NULL);",
        "INSERT INTO _sqlx_migrations VALUES(39, 1);",
        "CREATE TABLE threads(id INTEGER PRIMARY KEY, payload BLOB);",
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1024)",
        "INSERT INTO threads(payload) SELECT zeroblob(4096) FROM n;",
        "DELETE FROM threads WHERE id <= 900;",
        "PRAGMA wal_checkpoint(TRUNCATE);",
      ].join(" "),
    ]);
    const before = await inspectCodexDatabase(originalPath);
    expect(before.estimatedReclaimBytes).toBeGreaterThan(0);
    const selectedAction: DatabaseVacuumAction = {
      ...action(originalPath),
      expectedReclaimBytes: before.estimatedReclaimBytes,
      target: before.identity,
    };
    const offline = {
      inspectProcesses: async () => ({ status: "idle" as const, pids: [] as [] }),
      inspectOpenHandles: async () => ({ status: "idle" as const, pids: [] as [] }),
    };

    const result = await executeDatabaseVacuum(selectedAction, {
      runId: "run-sqlite",
      entryId: "entry-sqlite",
      backupDirectory,
      dependencies: offline,
    });
    const after = await inspectCodexDatabase(originalPath);
    expect(after.identity.measuredBytes).toBeLessThan(before.identity.measuredBytes);
    expect(after.identity.autoVacuum).toBe(2);

    const manifestPath = join(backupDirectory, "entry-sqlite.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await undoDatabaseVacuum(manifest, {
      manifestPath,
      backupDirectory,
      dependencies: offline,
    });
    expect((await inspectCodexDatabase(originalPath)).identity.fingerprint).toBe(
      before.identity.fingerprint,
    );
    expect(result.reclaimedBytes).toBeGreaterThan(0);
  });

  it("retains the original, installs the compacted copy, and restores through undo", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-executor-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");

    const result = await executeDatabaseVacuum(action(originalPath), {
      runId: "run-1",
      entryId: "entry-1",
      backupDirectory,
      dependencies: dependencies(),
    });

    expect(await readFile(originalPath, "utf8")).toBe("compacted");
    expect(await readFile(result.backupPath, "utf8")).toBe("original");
    expect(result.reclaimedBytes).toBe(768);
    const manifestPath = join(backupDirectory, "entry-1.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    expect(manifest.status).toBe("installed");

    const restored = await undoDatabaseVacuum(manifest, {
      manifestPath,
      backupDirectory,
      dependencies: dependencies(),
    });

    expect(restored.status).toBe("restored");
    expect(await readFile(originalPath, "utf8")).toBe("original");
    await expect(lstat(result.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes an interrupted sidecar restore without losing either database", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-resume-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await writeFile(`${originalPath}-wal`, "");
    await writeFile(`${originalPath}-shm`, "synthetic shm");
    const selectedAction = {
      ...action(originalPath),
      target: (await dependencies().inspectDatabase(originalPath)).identity,
    };
    await executeDatabaseVacuum(selectedAction, {
      runId: "run-resume",
      entryId: "entry-resume",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-resume.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));

    await expect(
      undoDatabaseVacuum(manifest, {
        manifestPath,
        backupDirectory,
        dependencies: {
          ...dependencies(),
          async rename(source, destination) {
            if (source.endsWith("-shm")) {
              throw new Error("injected SHM restore failure");
            }
            await rename(source, destination);
          },
        },
      }),
    ).rejects.toThrow("injected SHM restore failure");
    const interrupted = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    expect(interrupted.status).toBe("restoring");

    const restored = await undoDatabaseVacuum(interrupted, {
      manifestPath,
      backupDirectory,
      dependencies: dependencies(),
    });
    expect(restored.status).toBe("restored");
    expect(await readFile(originalPath, "utf8")).toBe("original");
    expect(await readFile(`${originalPath}-shm`, "utf8")).toBe("synthetic shm");
    await expect(lstat(`${originalPath}-wal`)).resolves.toBeDefined();
  });

  it("rejects recovery manifests that escape their owned backup paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-paths-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await executeDatabaseVacuum(action(originalPath), {
      runId: "run-paths",
      entryId: "entry-paths",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-paths.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));

    await expect(
      undoDatabaseVacuum(
        {
          ...manifest,
          backupPath: join(root, "unowned.sqlite"),
        },
        {
          manifestPath,
          backupDirectory,
          dependencies: dependencies(),
        },
      ),
    ).rejects.toThrow("outside its owned backup set");
  });

  it("rolls back when the compacted copy cannot be installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-rollback-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    let moves = 0;

    await expect(
      executeDatabaseVacuum(action(originalPath), {
        runId: "run-2",
        entryId: "entry-2",
        backupDirectory,
        dependencies: {
          ...dependencies(),
          async rename(source, destination) {
            moves += 1;
            if (moves === 2) {
              throw new Error("injected install failure");
            }
            await rename(source, destination);
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      diagnosticCode: "DATABASE_INSTALL_ROLLED_BACK",
    });

    expect(await readFile(originalPath, "utf8")).toBe("original");
  });

  it("refuses undo after the installed database changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-drift-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await executeDatabaseVacuum(action(originalPath), {
      runId: "run-3",
      entryId: "entry-3",
      backupDirectory,
      dependencies: dependencies(),
    });
    await writeFile(originalPath, "original");
    const manifestPath = join(backupDirectory, "entry-3.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));

    await expect(
      undoDatabaseVacuum(manifest, {
        manifestPath,
        backupDirectory,
        dependencies: dependencies(),
      }),
    ).rejects.toThrow("changed after installation");
  });

  it("purges an expired rollback copy only while Codex is offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-purge-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    const result = await executeDatabaseVacuum(action(originalPath), {
      runId: "run-4",
      entryId: "entry-4",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-4.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));

    const purged = await purgeDatabaseBackup(manifest, {
      manifestPath,
      backupDirectory,
      dependencies: dependencies(),
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe("original".length);
    await expect(lstat(result.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
