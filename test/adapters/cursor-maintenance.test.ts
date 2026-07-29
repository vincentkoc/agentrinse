import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cursorNativeMaintenanceFor,
  inspectCursorDatabaseCompanions,
} from "../../src/adapters/cursor-maintenance.js";
import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-cursor-maintenance-")),
    now: new Date("2026-07-29T00:00:00.000Z"),
    auditId: "audit-cursor-maintenance",
  };
}

describe("Cursor native database maintenance reporting", () => {
  it("inventories the exact global database and its companions without creating actions", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "cursor-data");
    const database = join(root, "User", "globalStorage", "state.vscdb");
    await mkdir(join(root, "User", "workspaceStorage", "workspace"), { recursive: true });
    await mkdir(join(root, "logs"), { recursive: true });
    await mkdir(join(root, "User", "globalStorage"), { recursive: true });
    await writeFile(database, "database");
    await writeFile(`${database}.backup`, "backup-copy");
    await writeFile(`${database}-wal`, "wal");
    await symlink(join(root, "outside-shm"), `${database}-shm`);
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.cursor, {
      root,
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const databaseResource = collection.resources.find(
      (resource) => resource.resource.displayName === "Cursor global state database",
    );
    const finding = databaseResource
      ? await adapter.classify(context, databaseResource)
      : undefined;

    expect(databaseResource?.resource.path).toBe(database);
    expect(databaseResource?.measuredBytes).toBe(8);
    expect(databaseResource?.facts.databaseCompanions).toEqual([
      { suffix: ".backup", status: "regular", measuredBytes: 11 },
      { suffix: "-wal", status: "regular", measuredBytes: 3 },
      { suffix: "-shm", status: "symlink" },
    ]);
    expect(databaseResource?.facts.nativeMaintenance).toEqual(
      cursorNativeMaintenanceFor("User/globalStorage/state.vscdb"),
    );
    expect(finding).toMatchObject({
      state: "protected",
      confidence: "unknown",
      candidateActions: [],
      roots: [
        { code: "cursor-native-database-maintenance-version-unverified" },
        { code: "provider-owned-report-only" },
      ],
    });
  });

  it("reports missing database companions without following paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-cursor-companions-"));
    const database = join(root, "state.vscdb");
    await writeFile(database, "database");

    await expect(inspectCursorDatabaseCompanions(database)).resolves.toEqual([
      { suffix: ".backup", status: "missing" },
      { suffix: "-wal", status: "missing" },
      { suffix: "-shm", status: "missing" },
    ]);
  });

  it("recognizes the Windows global database path", () => {
    expect(cursorNativeMaintenanceFor("User\\globalStorage\\state.vscdb")).toBeDefined();
  });
});
