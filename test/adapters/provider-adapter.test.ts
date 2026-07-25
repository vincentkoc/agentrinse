import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import type { DatabaseIdentity } from "../../src/contracts/action.js";

function databaseIdentity(path: string): DatabaseIdentity {
  return {
    path,
    database: "state",
    filename: "state_5.sqlite",
    device: 1,
    inode: 2,
    mode: 0o100600,
    mtimeMs: 3,
    measuredBytes: 1024 * 1024 * 1024,
    pageSize: 4096,
    pageCount: 262_144,
    freelistCount: 196_608,
    journalMode: "wal",
    autoVacuum: 0,
    migrationVersion: 39,
    tables: ["_sqlx_migrations", "threads"],
    schemaDigest: "a".repeat(64),
    fingerprint: "b".repeat(64),
  };
}

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-provider-")),
    now: new Date("2026-07-23T00:00:00.000Z"),
    auditId: "audit-fixture",
  };
}

describe("ProviderAuditAdapter", () => {
  it("reports a missing provider without failing", async () => {
    const context = await fixtureContext();
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);

    expect(probe.status).toBe("absent");
    expect((await adapter.collect(context, probe)).resources).toEqual([]);
  });

  it("inventories known provider resources as report-only", async () => {
    const context = await fixtureContext();
    const sessions = join(context.home, ".codex", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "thread.jsonl"), "synthetic fixture");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(context, collection.resources[0]!);

    expect(probe.status).toBe("available");
    expect(collection.resources).toHaveLength(1);
    expect(collection.resources[0]?.resource.displayName).toBe("Codex sessions");
    expect(collection.resources[0]?.measuredBytes).toBe(17);
    expect(finding.state).toBe("protected");
    expect(finding.roots[0]?.code).toBe("provider-owned-report-only");
  });

  it("blocks a symlinked provider root", async () => {
    const context = await fixtureContext();
    const target = await mkdtemp(join(tmpdir(), "agentrinse-target-"));
    await symlink(target, join(context.home, ".grok"));
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.grok, {
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);

    expect(probe.status).toBe("degraded");
    expect(probe.diagnostics[0]?.code).toBe("PROVIDER_ROOT_SYMLINK");
  });

  it("proposes an experimental offline vacuum only with explicit authorization", async () => {
    const context = await fixtureContext();
    const path = join(context.home, ".codex", "state_5.sqlite");
    await mkdir(join(context.home, ".codex"), { recursive: true });
    await writeFile(path, "synthetic");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      measureBytes: true,
      maxEntries: 100,
      allowOfflineVacuum: true,
      inspectDatabase: async () => ({
        identity: databaseIdentity(path),
        estimatedReclaimBytes: 768 * 1024 * 1024,
        freePageRatio: 0.75,
        quickCheck: "ok",
        walBytes: 0,
        shmBytes: 0,
        sidecarsPresent: false,
      }),
      databaseDependencies: {
        runLsof: async () => ({ stdout: "", stderr: "" }),
        runPs: async () => ({ stdout: "", stderr: "" }),
      },
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(context, collection.resources[0]!);

    expect(finding.state).toBe("eligible");
    expect(finding.candidateActions[0]).toMatchObject({
      type: "database.vacuum",
      adapter: "codex",
      risk: "experimental",
      expectedReclaimBytes: 768 * 1024 * 1024,
    });
  });

  it("keeps the same database protected without the offline vacuum flag", async () => {
    const context = await fixtureContext();
    const path = join(context.home, ".codex", "state_5.sqlite");
    await mkdir(join(context.home, ".codex"), { recursive: true });
    await writeFile(path, "synthetic");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      measureBytes: true,
      maxEntries: 100,
      inspectDatabase: async () => ({
        identity: databaseIdentity(path),
        estimatedReclaimBytes: 768 * 1024 * 1024,
        freePageRatio: 0.75,
        quickCheck: "ok",
        walBytes: 0,
        shmBytes: 0,
        sidecarsPresent: false,
      }),
      databaseDependencies: {
        runLsof: async () => ({ stdout: "", stderr: "" }),
        runPs: async () => ({ stdout: "", stderr: "" }),
      },
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(context, collection.resources[0]!);

    expect(finding.state).toBe("protected");
    expect(finding.candidateActions).toEqual([]);
    expect(finding.roots.map((root) => root.code)).toContain("provider-owned-report-only");
  });

  it("keeps ordinary Codex database inventory independent of sqlite3", async () => {
    const context = await fixtureContext();
    const path = join(context.home, ".codex", "state_5.sqlite");
    await mkdir(join(context.home, ".codex"), { recursive: true });
    await writeFile(path, "synthetic");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      measureBytes: true,
      maxEntries: 100,
      inspectDatabase: async () => {
        throw new Error("sqlite3 should not be required");
      },
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const database = collection.resources.find(
      (resource) => resource.resource.kind === "agent-database",
    );

    expect(database?.measuredBytes).toBe("synthetic".length);
    expect(database?.facts.reportOnly).toBe(true);
    expect(collection.diagnostics).toEqual([]);
  });

  it.each(["codex", "claude", "cursor", "copilot", "zed", "opencode", "grok"] as const)(
    "defines a %s adapter root inside the synthetic home",
    (id) => {
      const root = PROVIDER_SPECS[id].defaultRoot("/fixture/home", "darwin");

      expect(root.startsWith("/fixture/home/")).toBe(true);
    },
  );
});
