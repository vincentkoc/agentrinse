import { lstat, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DatabaseIdentity, DatabaseVacuumAction } from "../../src/contracts/action.js";
import { databaseBackupEntrySchema } from "../../src/contracts/database-backup.js";
import { executeDatabaseVacuum } from "../../src/core/database-executor.js";
import { purgeDatabaseBackup, undoDatabaseVacuum } from "../../src/core/database-recovery.js";
import { readJsonFile } from "../../src/state/json-file.js";

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
      return {
        identity: identity(path, content),
        estimatedReclaimBytes: content === "original" ? 768 : 0,
        freePageRatio: content === "original" ? 0.75 : 0,
        quickCheck: "ok" as const,
        walBytes: 0,
        shmBytes: 0,
        sidecarsPresent: false,
      };
    },
  };
}

describe("database vacuum execution and recovery", () => {
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
