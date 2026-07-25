import { execFile, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { DatabaseIdentity, DatabaseVacuumAction } from "../../src/contracts/action.js";
import { databaseBackupEntrySchema } from "../../src/contracts/database-backup.js";
import { executeDatabaseVacuum } from "../../src/core/database-executor.js";
import { purgeDatabaseBackup, undoDatabaseVacuum } from "../../src/core/database-recovery.js";
import { exchangePaths } from "../../src/core/no-clobber-rename.js";
import { readJsonFile } from "../../src/state/json-file.js";
import {
  CODEX_DATABASE_CONTRACTS,
  inspectCodexDatabase,
} from "../../src/adapters/codex-database.js";

const execFileAsync = promisify(execFile);
const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function identity(path: string, content: "original" | "compacted" | "used"): DatabaseIdentity {
  const contract = CODEX_DATABASE_CONTRACTS["state_5.sqlite"];
  const original = content === "original";
  const compacted = content === "compacted";
  return {
    path,
    database: "state",
    filename: "state_5.sqlite",
    device: 1,
    inode: original ? 10 : compacted ? 11 : 12,
    mode: 0o100600,
    mtimeMs: original ? 100 : compacted ? 200 : 300,
    measuredBytes: original ? 1024 : compacted ? 256 : 512,
    pageSize: 4096,
    pageCount: original ? 4 : compacted ? 1 : 2,
    freelistCount: original ? 3 : 0,
    journalMode: "wal",
    autoVacuum: original ? 0 : 2,
    migrationVersion: contract.migrationVersion,
    migrationDigest: contract.migrationDigest,
    tables: ["_sqlx_migrations", "threads"],
    schemaDigest: contract.schemaDigest,
    fingerprint: (original ? "b" : compacted ? "c" : "d").repeat(64),
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
    acquireExclusion: async (paths: string[]) => ({
      identities: new Map(
        await Promise.all(
          paths.map(async (path) => {
            const content = (await readFile(path, "utf8")) as "original" | "compacted" | "used";
            return [path, { ...identity(path, content) }] as const;
          }),
        ),
      ),
      release: async () => undefined,
    }),
    inspectDatabase: async (path: string) => {
      const content = (await readFile(path, "utf8")) as "original" | "compacted" | "used";
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
        "CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);",
        "INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) VALUES(39, 'threads recency at', 1, X'00', 0);",
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
    };
    let exchanges = 0;
    const exchangeWhileLocked = async (source: string, destination: string) => {
      await expect(
        execFileAsync("sqlite3", [
          "-batch",
          "-cmd",
          ".timeout 0",
          source,
          "INSERT INTO threads(payload) VALUES(zeroblob(1));",
        ]),
      ).rejects.toBeDefined();
      exchanges += 1;
      await exchangePaths(source, destination);
    };

    const result = await executeDatabaseVacuum(selectedAction, {
      runId: "run-sqlite",
      entryId: "entry-sqlite",
      backupDirectory,
      dependencies: { ...offline, exchange: exchangeWhileLocked },
    });
    const after = await inspectCodexDatabase(originalPath);
    expect(after.identity.measuredBytes).toBeLessThan(before.identity.measuredBytes);
    expect(after.identity.autoVacuum).toBe(2);

    const manifestPath = join(backupDirectory, "entry-sqlite.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await undoDatabaseVacuum(manifest, {
      manifestPath,
      backupDirectory,
      dependencies: { ...offline, exchange: exchangeWhileLocked },
    });
    expect((await inspectCodexDatabase(originalPath)).identity.fingerprint).toBe(
      before.identity.fingerprint,
    );
    expect(result.reclaimedBytes).toBe(0);
    expect(result.retainedBackupBytes).toBe(
      before.identity.measuredBytes +
        (before.identity.wal?.measuredBytes ?? 0) +
        (before.identity.shm?.measuredBytes ?? 0),
    );
    expect(exchanges).toBe(2);
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
    expect(result.reclaimedBytes).toBe(0);
    expect(result.retainedBackupBytes).toBe(action(originalPath).target.measuredBytes);
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

  it("creates the vacuum output inside an owner-only temporary directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-private-temp-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    let temporaryMode: number | undefined;

    await executeDatabaseVacuum(action(originalPath), {
      runId: "run-private-temp",
      entryId: "entry-private-temp",
      backupDirectory,
      dependencies: {
        ...dependencies(),
        async vacuumInto(_source, destination) {
          temporaryMode = (await lstat(dirname(destination))).mode & 0o777;
          await writeFile(destination, "compacted");
        },
      },
    });

    expect(temporaryMode).toBe(0o700);
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
    await expect(
      executeDatabaseVacuum(action(originalPath), {
        runId: "run-2",
        entryId: "entry-2",
        backupDirectory,
        dependencies: {
          ...dependencies(),
          async rename(source, destination) {
            if (destination.endsWith(".original")) {
              throw new Error("injected archive failure");
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

  it("rolls back an exchanged database when a sidecar archive fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-sidecar-rollback-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await writeFile(`${originalPath}-wal`, "");
    await writeFile(`${originalPath}-shm`, "synthetic shm");
    const baseDependencies = dependencies();
    const selectedAction = {
      ...action(originalPath),
      target: (await baseDependencies.inspectDatabase(originalPath)).identity,
    };

    await expect(
      executeDatabaseVacuum(selectedAction, {
        runId: "run-sidecar-rollback",
        entryId: "entry-sidecar-rollback",
        backupDirectory,
        dependencies: {
          ...baseDependencies,
          async rename(source, destination) {
            if (source.endsWith("-shm")) {
              throw new Error("injected SHM archive failure");
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
    expect(await readFile(`${originalPath}-shm`, "utf8")).toBe("synthetic shm");
    const manifest = databaseBackupEntrySchema.parse(
      await readJsonFile(join(backupDirectory, "entry-sidecar-rollback.json")),
    );
    expect(manifest.status).toBe("restored");
  });

  it("finishes an executor-produced partial rollback through undo", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-partial-rollback-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await writeFile(`${originalPath}-wal`, "");
    await writeFile(`${originalPath}-shm`, "synthetic shm");
    const baseDependencies = dependencies();
    const selectedAction = {
      ...action(originalPath),
      target: (await baseDependencies.inspectDatabase(originalPath)).identity,
    };

    await expect(
      executeDatabaseVacuum(selectedAction, {
        runId: "run-partial",
        entryId: "entry-partial",
        backupDirectory,
        dependencies: {
          ...baseDependencies,
          async rename(source, destination) {
            if (source.endsWith("-shm") || source.includes(".original-wal")) {
              throw new Error("injected rollback sidecar failure");
            }
            await rename(source, destination);
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "partially-applied",
      diagnosticCode: "DATABASE_INSTALL_ROLLBACK_PARTIAL",
    });
    const manifestPath = join(backupDirectory, "entry-partial.json");
    const partial = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    expect(partial.status).toBe("partial");

    const restored = await undoDatabaseVacuum(partial, {
      manifestPath,
      backupDirectory,
      dependencies: dependencies(),
    });
    expect(restored.status).toBe("restored");
    expect(await readFile(originalPath, "utf8")).toBe("original");
    expect(await readFile(`${originalPath}-shm`, "utf8")).toBe("synthetic shm");
  });

  it("removes the compacted temporary file when the pre-swap identity becomes stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-stale-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    const baseDependencies = dependencies();

    await expect(
      executeDatabaseVacuum(action(originalPath), {
        runId: "run-stale",
        entryId: "entry-stale",
        backupDirectory,
        dependencies: {
          ...baseDependencies,
          async inspectDatabase(path) {
            const inspection = await baseDependencies.inspectDatabase(path);
            return path === originalPath
              ? {
                  ...inspection,
                  identity: {
                    ...inspection.identity,
                    fingerprint: "d".repeat(64),
                  },
                }
              : inspection;
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "DATABASE_IDENTITY_CHANGED",
    });
    const manifestPath = join(backupDirectory, "entry-stale.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    expect(manifest.status).toBe("restored");
    await expect(lstat(manifest.temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a WAL created after exclusive access is acquired", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-late-wal-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    const baseDependencies = dependencies();

    await expect(
      executeDatabaseVacuum(action(originalPath), {
        runId: "run-late-wal",
        entryId: "entry-late-wal",
        backupDirectory,
        dependencies: {
          ...baseDependencies,
          async acquireExclusion(paths) {
            const exclusion = await baseDependencies.acquireExclusion(paths);
            await writeFile(`${originalPath}-wal`, "late commit");
            return exclusion;
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "DATABASE_IDENTITY_CHANGED",
    });
    expect(await readFile(originalPath, "utf8")).toBe("original");
  });

  it("restores the original after a crash between exchange and archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-exchange-crash-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await writeFile(`${originalPath}-wal`, "");
    await writeFile(`${originalPath}-shm`, "synthetic shm");
    const baseDependencies = dependencies();
    const selectedAction = {
      ...action(originalPath),
      target: (await baseDependencies.inspectDatabase(originalPath)).identity,
    };
    await executeDatabaseVacuum(selectedAction, {
      runId: "run-exchange-crash",
      entryId: "entry-exchange-crash",
      backupDirectory,
      dependencies: baseDependencies,
    });
    const manifestPath = join(backupDirectory, "entry-exchange-crash.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await mkdir(dirname(manifest.temporaryPath));
    await rename(manifest.backupPath, manifest.temporaryPath);
    await rename(manifest.backupWalPath!, `${originalPath}-wal`);
    await rename(manifest.backupShmPath!, `${originalPath}-shm`);
    await chmod(originalPath, 0o400);
    await chmod(manifest.temporaryPath, 0o400);

    const restored = await undoDatabaseVacuum(
      {
        ...manifest,
        status: "installing",
      },
      {
        manifestPath,
        backupDirectory,
        dependencies: {
          ...baseDependencies,
          async acquireExclusion(paths, _platform, restoreModes) {
            for (const path of paths) {
              await chmod(path, (restoreModes?.get(path) ?? 0o600) & 0o777);
            }
            return baseDependencies.acquireExclusion(paths);
          },
        },
      },
    );

    expect(restored.status).toBe("restored");
    expect(await readFile(originalPath, "utf8")).toBe("original");
    expect((await lstat(originalPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${originalPath}-shm`, "utf8")).toBe("synthetic shm");
    await expect(lstat(manifest.temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the original after a crash in the installing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-installing-crash-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await executeDatabaseVacuum(action(originalPath), {
      runId: "run-installing",
      entryId: "entry-installing",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-installing.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));

    const restored = await undoDatabaseVacuum(
      {
        ...manifest,
        status: "installing",
      },
      {
        manifestPath,
        backupDirectory,
        dependencies: dependencies(),
      },
    );

    expect(restored.status).toBe("restored");
    expect(await readFile(originalPath, "utf8")).toBe("original");
    await expect(lstat(manifest.temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes an original-only rollback after an interrupted sidecar restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-original-only-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await writeFile(`${originalPath}-shm`, "synthetic shm");
    const baseDependencies = dependencies();
    const selectedAction = {
      ...action(originalPath),
      target: (await baseDependencies.inspectDatabase(originalPath)).identity,
    };
    await executeDatabaseVacuum(selectedAction, {
      runId: "run-original-only",
      entryId: "entry-original-only",
      backupDirectory,
      dependencies: baseDependencies,
    });
    const manifestPath = join(backupDirectory, "entry-original-only.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await exchangePaths(originalPath, manifest.backupPath);
    await rm(manifest.backupPath);

    const restored = await undoDatabaseVacuum(
      {
        ...manifest,
        status: "installing",
      },
      {
        manifestPath,
        backupDirectory,
        dependencies: baseDependencies,
      },
    );

    expect(restored.status).toBe("restored");
    expect(await readFile(originalPath, "utf8")).toBe("original");
    expect(await readFile(`${originalPath}-shm`, "utf8")).toBe("synthetic shm");
    await expect(lstat(manifest.backupShmPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses interrupted-install recovery after the compacted database changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-installing-drift-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await executeDatabaseVacuum(action(originalPath), {
      runId: "run-installing-drift",
      entryId: "entry-installing-drift",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-installing-drift.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await writeFile(originalPath, "original");

    await expect(
      undoDatabaseVacuum(
        {
          ...manifest,
          status: "installing",
        },
        {
          manifestPath,
          backupDirectory,
          dependencies: dependencies(),
        },
      ),
    ).rejects.toThrow("changed after installation");
    expect(await readFile(originalPath, "utf8")).toBe("original");
  });

  it("rechecks authorization immediately before the first database rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-expiry-boundary-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    let authorizationChecks = 0;

    await expect(
      executeDatabaseVacuum(action(originalPath), {
        runId: "run-expiry",
        entryId: "entry-expiry",
        backupDirectory,
        dependencies: {
          ...dependencies(),
          authorization: {
            expiresAtMs: 1,
            now: () => new Date(authorizationChecks++ < 2 ? 0 : 1),
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "PLAN_EXPIRED_DURING_DATABASE_VACUUM",
    });
    const manifest = databaseBackupEntrySchema.parse(
      await readJsonFile(join(backupDirectory, "entry-expiry.json")),
    );
    expect(manifest.status).toBe("restored");
    await expect(lstat(manifest.temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("rechecks Codex ownership immediately before the undo rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-undo-boundary-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    await executeDatabaseVacuum(action(originalPath), {
      runId: "run-undo-boundary",
      entryId: "entry-undo-boundary",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-undo-boundary.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    let processChecks = 0;

    await expect(
      undoDatabaseVacuum(manifest, {
        manifestPath,
        backupDirectory,
        dependencies: {
          ...dependencies(),
          inspectProcesses: async () =>
            processChecks++ === 0
              ? { status: "idle" as const, pids: [] as [] }
              : { status: "busy" as const, pids: [42] },
        },
      }),
    ).rejects.toThrow("Codex is running");
    expect(await readFile(originalPath, "utf8")).toBe("compacted");
    expect(await readFile(manifest.backupPath, "utf8")).toBe("original");
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
    const baseDependencies = dependencies();
    let processChecks = 0;
    let releasedAfterDeletion = false;

    const purged = await purgeDatabaseBackup(manifest, {
      manifestPath,
      backupDirectory,
      dependencies: {
        ...baseDependencies,
        inspectProcesses: async () => {
          processChecks += 1;
          return { status: "idle" as const, pids: [] as [] };
        },
        async acquireExclusion(paths) {
          const exclusion = await baseDependencies.acquireExclusion(paths);
          return {
            identities: exclusion.identities,
            async release() {
              await expect(lstat(result.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
              releasedAfterDeletion = true;
              await exclusion.release();
            },
          };
        },
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe("original".length);
    expect(processChecks).toBe(2);
    expect(releasedAfterDeletion).toBe(true);
    await expect(lstat(result.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purges a healthy rollback copy after normal Codex database writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-purge-used-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    const result = await executeDatabaseVacuum(action(originalPath), {
      runId: "run-purge-used",
      entryId: "entry-purge-used",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-purge-used.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await writeFile(originalPath, "used");

    const purged = await purgeDatabaseBackup(manifest, {
      manifestPath,
      backupDirectory,
      dependencies: dependencies(),
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.entry.installedIdentity).toEqual(identity(originalPath, "used"));
    expect(purged.reclaimedBytes).toBe("original".length);
    await expect(lstat(result.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes a purging manifest after the rollback file was already removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-purge-resume-"));
    const originalPath = join(root, "state_5.sqlite");
    const backupDirectory = join(root, "backups");
    await writeFile(originalPath, "original");
    const result = await executeDatabaseVacuum(action(originalPath), {
      runId: "run-purge-resume",
      entryId: "entry-purge-resume",
      backupDirectory,
      dependencies: dependencies(),
    });
    const manifestPath = join(backupDirectory, "entry-purge-resume.json");
    const manifest = databaseBackupEntrySchema.parse(await readJsonFile(manifestPath));
    await rm(result.backupPath);

    const purged = await purgeDatabaseBackup(
      {
        ...manifest,
        status: "purging",
      },
      {
        manifestPath,
        backupDirectory,
        dependencies: dependencies(),
      },
    );

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe(0);
  });
});
