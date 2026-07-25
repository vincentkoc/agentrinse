import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { DatabaseVacuumAction } from "../../src/contracts/action.js";
import { revalidateDatabaseVacuum } from "../../src/core/database-revalidation.js";

describe("database vacuum revalidation", () => {
  it("reserves peak space for the compacted copy and its normalization vacuum", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-db-space-"));
    const root = join(home, ".codex");
    const path = join(root, "state_5.sqlite");
    await mkdir(root);
    const measuredBytes = 1024 * 1024 * 1024;
    const action: DatabaseVacuumAction = {
      actionId: "database.vacuum:space",
      type: "database.vacuum",
      adapter: "codex",
      resourceId: "codex:agent-database:space",
      risk: "experimental",
      description: "Compact synthetic Codex state database",
      expectedReclaimBytes: measuredBytes / 2,
      backupTtlMinutes: 60,
      target: {
        path,
        database: "state",
        filename: "state_5.sqlite",
        device: 1,
        inode: 2,
        mode: 0o100600,
        mtimeMs: 3,
        measuredBytes,
        pageSize: 4096,
        pageCount: measuredBytes / 4096,
        freelistCount: measuredBytes / 8192,
        journalMode: "wal",
        autoVacuum: 0,
        migrationVersion: 39,
        tables: ["_sqlx_migrations", "threads"],
        schemaDigest: "a".repeat(64),
        fingerprint: "b".repeat(64),
      },
    };
    const config = structuredClone(DEFAULT_CONFIG);
    const peakBytes = measuredBytes * 2 + 64 * 1024 * 1024;
    const dependencies = {
      inspectDatabase: async () => ({
        identity: action.target,
        estimatedReclaimBytes: action.expectedReclaimBytes,
        freePageRatio: 0.5,
        quickCheck: "ok" as const,
        walBytes: 0,
        shmBytes: 0,
        sidecarsPresent: false,
      }),
      inspectProcesses: async () => ({ status: "idle" as const, pids: [] as [] }),
      inspectOpenHandles: async () => ({ status: "idle" as const, pids: [] as [] }),
    };

    const insufficient = await revalidateDatabaseVacuum(action, home, config, {
      ...dependencies,
      availableBytes: async () => peakBytes - 1,
    });
    expect(insufficient).toMatchObject({
      status: "stale",
      diagnostic: { code: "DATABASE_SPACE_INSUFFICIENT" },
    });

    await expect(
      revalidateDatabaseVacuum(action, home, config, {
        ...dependencies,
        availableBytes: async () => peakBytes,
      }),
    ).resolves.toEqual({ status: "eligible" });
  });
});
