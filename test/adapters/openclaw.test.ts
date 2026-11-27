import { lstat, mkdir, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import { inspectOpenClawDatabase } from "../../src/adapters/openclaw-database.js";
import { openClawOwnership } from "../../src/adapters/openclaw-ownership.js";
import { createAuditAdapters } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { runAudit } from "../../src/core/audit.js";
import { createCleanupPlan } from "../../src/core/plan.js";
import { applyCleanupPlan } from "../../src/core/apply.js";
import { ReachabilityIndex } from "../../src/core/reachability.js";
import { executeProviderFileQuarantine } from "../../src/core/provider-file-executor.js";
import { revalidateProviderFileQuarantine } from "../../src/core/provider-file-revalidation.js";
import { undoProviderFileQuarantine } from "../../src/core/provider-file-recovery.js";
import { providerFileQuarantineEntrySchema } from "../../src/contracts/provider-file-quarantine.js";
import { stateLayout } from "../../src/state/layout.js";

async function tempHome() {
  return realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-claw-")));
}

describe("OpenClaw storage", () => {
  it("counts a configured direct workspace and its memory once, even when an agent shares its directory", async () => {
    const home = await tempHome();
    const root = join(home, ".openclaw");
    const workspace = join(root, "custom");
    const credentials = join(root, "credentials");
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(credentials);
    await writeFile(join(workspace, "notes.txt"), "123");
    await writeFile(join(workspace, "MEMORY.md"), "12345");
    await writeFile(join(workspace, "memory", "entry.md"), "1234567");
    await writeFile(
      join(root, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { workspace },
          entries: { other: { agentDir: workspace, workspace: credentials } },
        },
      }),
    );
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.openclaw = { enabled: true, root };
    const audit = await runAudit({
      home,
      config,
      adapters: createAuditAdapters(config, process.platform, { environment: {} }).filter(
        (adapter) => adapter.id === "openclaw",
      ),
    });
    const findingsAt = (path: string) =>
      audit.findings.filter((finding) => finding.resource.path === path);
    for (const [path, surface, bytes] of [
      [workspace, "workspace", 3],
      [join(workspace, "MEMORY.md"), "memory", 5],
      [join(workspace, "memory"), "memory", 7],
      [credentials, "credentials", 0],
    ] as const) {
      expect(findingsAt(path)).toMatchObject([
        {
          state: "protected",
          facts: { openClawSurface: surface },
          measuredBytes: bytes,
          candidateActions: [],
        },
      ]);
    }
  });

  it("reads bounded owner counts and withholds them for a pending WAL or unsupported schema", async () => {
    const path = join(await tempHome(), "openclaw-agent.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER) STRICT;
      INSERT INTO schema_meta VALUES('primary','agent',38);
      CREATE TABLE session_nodes(session_key TEXT, archived_at INTEGER, pinned_at INTEGER, status TEXT) STRICT;
      INSERT INTO session_nodes VALUES('private-key-one',NULL,1,'running'),('private-key-two',2,NULL,'done');
      CREATE TABLE transcript_events(body TEXT) STRICT;
      INSERT INTO transcript_events VALUES('private transcript');
      CREATE TABLE memory_index_sources(body TEXT) STRICT;
      CREATE TABLE memory_embedding_cache(body TEXT) STRICT;
    `);
    db.close();
    expect(await inspectOpenClawDatabase(path, "agent", 10)).toMatchObject({
      status: "observed",
      truncated: false,
      counts: {
        sessionRows: 2,
        pinnedSessions: 1,
        runningSessions: 1,
        archivedSessions: 1,
        transcriptEvents: 1,
        memorySources: 0,
      },
    });
    expect(await inspectOpenClawDatabase(path, "agent", 1)).toMatchObject({
      truncated: true,
      counts: { sessionRows: 1 },
    });
    expect(await inspectOpenClawDatabase(path, "global", 10)).toEqual({ status: "unsupported" });
    await writeFile(path + "-wal", "pending");
    expect(await inspectOpenClawDatabase(path, "agent", 10)).toEqual({ status: "uncheckpointed" });
  });

  it("protects external checkout and workspace paths and fails closed when owner evidence is incomplete", async () => {
    const home = await tempHome();
    const root = join(home, ".openclaw");
    const configured = join(home, "external-workspace");
    const checkout = join(home, "old-root", "owned");
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      join(root, "openclaw.json"),
      JSON.stringify({ agents: { entries: { main: { workspace: configured } } } }),
    );
    const db = new DatabaseSync(join(root, "state", "openclaw.sqlite"));
    db.exec(`CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER) STRICT;
      INSERT INTO schema_meta VALUES('primary','global',36);
      CREATE TABLE worktrees(id TEXT,path TEXT,repo_root TEXT,owner_kind TEXT,removed_at INTEGER,snapshot_ref TEXT) STRICT;`);
    db.prepare("INSERT INTO worktrees VALUES('id',?,?,'session',NULL,'snapshot')").run(
      checkout,
      configured,
    );
    db.close();
    const index = new ReachabilityIndex();
    await openClawOwnership(root, home, {}, 10, index);
    const now = new Date().toISOString();
    for (const path of [configured, checkout]) {
      expect(index.rootsFor(join(path, "dist"), now).map((r) => r.code)).toContain(
        "openclaw-owned-path",
      );
    }
    expect(index.rootsFor(join(home, "unrelated"), now)).toEqual([]);
    await writeFile(
      join(root, "openclaw.json"),
      JSON.stringify({ $include: "another-file.json5" }),
    );
    const unresolved = new ReachabilityIndex();
    await openClawOwnership(root, home, {}, 10, unresolved);
    expect(unresolved.rootsFor(join(home, "unrelated"), now).map((r) => r.code)).toContain(
      "openclaw-ownership-incomplete",
    );
  });

  it.runIf(["darwin", "linux"].includes(process.platform))(
    "plans, journals and restores only an old, owner-generated shell snapshot",
    async () => {
      const home = await tempHome();
      const root = join(home, ".openclaw");
      const cache = join(root, "cache", "shell-snapshots");
      await mkdir(cache, { recursive: true });
      const snapshot = join(cache, "a".repeat(64) + ".sh");
      const decoy = join(cache, "b".repeat(64) + ".sh");
      const recent = join(cache, "c".repeat(64) + ".sh");
      const contents = "# OpenClaw exec shell snapshot. Generated; do not edit.\ntrue\n";
      await writeFile(snapshot, contents);
      await writeFile(recent, contents);
      await writeFile(decoy, "personal script");
      await symlink(snapshot, join(cache, "d".repeat(64) + ".sh"));
      for (const file of [snapshot, decoy]) await utimes(file, new Date(0), new Date(0));
      const config = structuredClone(DEFAULT_CONFIG);
      config.adapters.openclaw = { enabled: true, root };
      const audit = await runAudit({
        home,
        config,
        adapters: createAuditAdapters(config, process.platform, { environment: {} }),
      });
      expect(createCleanupPlan(audit, config).actions).toEqual([]);
      config.plan.maxRisk = "recoverable";
      const plan = createCleanupPlan(audit, config);
      expect(plan.actions).toHaveLength(1);
      const action = plan.actions[0]!;
      if (action.type !== "provider.file-quarantine")
        throw new Error("Expected provider quarantine");
      expect(action.target.path).toBe(snapshot);
      const idle = {
        inspectProcesses: async () => ({ status: "idle" as const, pids: [] as [] }),
        inspectOpenHandles: async () => ({ status: "idle" as const, matches: [] as [] }),
      };
      expect(
        await revalidateProviderFileQuarantine(action, home, config, {
          ...idle,
          inspectProcesses: async () => ({ status: "busy", pids: [42] }),
        }),
      ).toMatchObject({ status: "stale", diagnostic: { code: "PROVIDER_ACTIVE" } });
      const state = join(home, "rinse-state");
      const applied = await applyCleanupPlan({
        input: plan,
        config,
        stateRoot: state,
        dependencies: {
          revalidateProviderFile: (a) => revalidateProviderFileQuarantine(a, home, config, idle),
          executeProviderFile: (a, options) =>
            executeProviderFileQuarantine(a, {
              ...options,
              dependencies: { ...options.dependencies, ...idle },
            }),
        },
      });
      const journal = JSON.parse(await readFile(applied.journalPath, "utf8"));
      expect(journal.actions[0].status).toBe("applied");
      const quarantineDirectory = stateLayout(state).providerQuarantine;
      const manifestPath = join(
        quarantineDirectory,
        journal.actions[0].quarantineEntryId + ".json",
      );
      const entry = providerFileQuarantineEntrySchema.parse(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      await expect(lstat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
      const restored = await undoProviderFileQuarantine(entry, {
        manifestPath,
        quarantineDirectory,
        dependencies: idle,
      });
      expect(restored.status).toBe("restored");
      expect(await readFile(snapshot, "utf8")).toBe(contents);
      expect(await readFile(decoy, "utf8")).toBe("personal script");
    },
  );
});
