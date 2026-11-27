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
import { revalidateArtifactRemove } from "../../src/core/artifact-revalidation.js";
import { runFixtureGit } from "../helpers/git.js";
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

function globalFixture(path: string, schema: number) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER) STRICT;
    CREATE TABLE worktrees(id TEXT,path TEXT,repo_root TEXT,owner_kind TEXT,removed_at INTEGER,snapshot_ref TEXT) STRICT;
    CREATE TABLE worktree_templates(repo_root TEXT, common_dir TEXT, worktree_root TEXT, path TEXT) STRICT;
    CREATE TABLE projects(repo_root TEXT) STRICT;`);
  db.prepare("INSERT INTO schema_meta VALUES('primary','global',?)").run(schema);
  return db;
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

  it.each([38, 42])(
    "reads bounded counts from agent schema %i and withholds pending WAL data",
    async (schema) => {
      const path = join(await tempHome(), "openclaw-agent.sqlite");
      const db = new DatabaseSync(path);
      db.exec(`
      CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER) STRICT;
      INSERT INTO schema_meta VALUES('primary','agent',${schema});
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
        schemaVersion: schema,
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
      const newer = new DatabaseSync(path);
      newer.exec("UPDATE schema_meta SET schema_version = 43");
      newer.close();
      expect(await inspectOpenClawDatabase(path, "agent", 10)).toEqual({ status: "unsupported" });
      await writeFile(path + "-wal", "pending");
      expect(await inspectOpenClawDatabase(path, "agent", 10)).toEqual({
        status: "uncheckpointed",
      });
    },
  );

  it.each([36, 40])(
    "protects verified global schema %i owners and withholds incomplete evidence",
    async (schema) => {
      const home = await tempHome();
      const root = join(home, ".openclaw");
      const configured = join(home, "external-workspace");
      const checkout = join(home, "old-root", "owned");
      await mkdir(join(root, "state"), { recursive: true });
      await writeFile(
        join(root, "openclaw.json"),
        JSON.stringify({ agents: { entries: { main: { workspace: configured } } } }),
      );
      const db = globalFixture(join(root, "state", "openclaw.sqlite"), schema);
      db.prepare("INSERT INTO worktrees VALUES('id',?,?,'session',NULL,'snapshot')").run(
        checkout,
        configured,
      );
      const templatePaths = ["source", "common", "pool", "template"].map((name) =>
        join(home, name),
      );
      const project = join(home, "registered-project");
      db.prepare("INSERT INTO worktree_templates VALUES(?,?,?,?)").run(...templatePaths);
      db.prepare("INSERT INTO projects VALUES(?)").run(project);
      db.close();
      const index = new ReachabilityIndex();
      await openClawOwnership(root, home, {}, 10, index);
      const now = new Date().toISOString();
      for (const path of [configured, checkout, ...templatePaths, project]) {
        expect(index.rootsFor(join(path, "dist"), now).map((r) => r.code)).toContain(
          "openclaw-owned-path",
        );
      }
      expect(index.rootsFor(join(home, "unrelated"), now)).toEqual([]);
      const limited = new ReachabilityIndex();
      const result = await openClawOwnership(root, home, {}, 2, limited);
      expect(result.registry).toMatchObject({
        status: "observed",
        truncated: true,
        counts: { registeredWorktrees: 1, registeredTemplates: 1, registeredProjects: 0 },
      });
      expect(limited.rootsFor(join(home, "unrelated"), now).map((r) => r.code)).toContain(
        "openclaw-ownership-incomplete",
      );
      await writeFile(
        join(root, "openclaw.json"),
        JSON.stringify({ $include: "another-file.json5" }),
      );
      const unresolved = new ReachabilityIndex();
      await openClawOwnership(root, home, {}, 10, unresolved);
      expect(unresolved.rootsFor(join(home, "unrelated"), now).map((r) => r.code)).toContain(
        "openclaw-ownership-incomplete",
      );
    },
  );

  it("uses effective state and agent engines before trusting the local registry", async () => {
    const home = await tempHome();
    const root = join(home, ".openclaw");
    const state = join(root, "state");
    await mkdir(state, { recursive: true });
    const path = join(state, "openclaw.sqlite");
    const db = globalFixture(path, 40);
    db.close();
    const sqlite = { engine: "sqlite" };
    const postgres = { engine: "postgres" };
    const bothLocal = { state: sqlite, agent: sqlite };
    const assess = async (database: unknown) => {
      await writeFile(join(root, "openclaw.json"), JSON.stringify({ database }));
      const index = new ReachabilityIndex();
      const owner = await openClawOwnership(root, home, {}, 10, index);
      const codes = index
        .rootsFor(join(home, "unrelated", "dist"), new Date().toISOString())
        .map((e) => e.code);
      return { registry: owner.registry.status, codes };
    };
    for (const database of [
      {},
      { families: {} },
      { families: { workboard: postgres } },
      { engine: "postgres", families: bothLocal },
    ]) {
      expect(await assess(database)).toEqual({ registry: "observed", codes: [] });
    }
    for (const database of [
      postgres,
      { families: { state: postgres } },
      { families: { agent: postgres } },
      { engine: "postgres", families: { agent: sqlite } },
      { engine: "postgres", families: { state: sqlite } },
      { families: { state: {} } },
      { families: null },
      { engine: "unexpected", families: bothLocal },
      { engine: "postgres", families: bothLocal, postgres: { ownership: "installation" } },
      { postgres: { ownership: "unknown" } },
    ]) {
      expect(await assess(database)).toEqual({
        registry: "owner-unresolved",
        codes: ["openclaw-ownership-incomplete"],
      });
    }
    const changed = new DatabaseSync(path);
    changed.exec("UPDATE schema_meta SET schema_version = 42");
    changed.close();
    expect(await assess(sqlite)).toEqual({
      registry: "unsupported",
      codes: ["openclaw-ownership-incomplete"],
    });
    await writeFile(path + "-journal", "pending");
    expect(await assess(sqlite)).toEqual({
      registry: "uncheckpointed",
      codes: ["openclaw-ownership-incomplete"],
    });
  });

  it.runIf(["darwin", "linux"].includes(process.platform))(
    "plans an unrelated ignored build and rechecks newly registered owners before removal",
    async () => {
      const home = await tempHome();
      const root = join(home, ".openclaw");
      const dbPath = join(root, "state", "openclaw.sqlite");
      const project = join(home, "source");
      const target = join(project, "dist");
      await mkdir(join(root, "state"), { recursive: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(root, "openclaw.json"), "{}");
      globalFixture(dbPath, 40).close();
      await runFixtureGit(["-C", project, "init", "--quiet"], { home });
      await writeFile(join(project, ".gitignore"), "dist/\n");
      await writeFile(join(target, "output"), "build");
      await utimes(join(target, "output"), new Date(0), new Date(0));
      await utimes(target, new Date(0), new Date(0));
      const config = structuredClone(DEFAULT_CONFIG);
      config.adapters.openclaw = { enabled: true, root };
      config.artifacts = {
        ...config.artifacts,
        projects: [{ root: project, names: ["dist"] }],
        minAgeMinutes: 0,
        minBytes: 0,
      };
      const processProbe = async () => ({ status: "idle" as const, matches: [] as [] });
      const audit = async () =>
        runAudit({
          home,
          config,
          adapters: createAuditAdapters(config, process.platform, {
            environment: {},
            processProbe,
          }).filter((a) => ["openclaw", "artifacts"].includes(a.id)),
        });
      const plan = createCleanupPlan(await audit(), config);
      expect(plan.actions).toHaveLength(1);
      const action = plan.actions[0]!;
      if (action.type !== "artifacts.remove") throw new Error("Expected an artifact removal");
      expect(action.target.path).toBe(target);
      const db = new DatabaseSync(dbPath);
      db.prepare("INSERT INTO worktree_templates VALUES(?,?,?,?)").run(
        project,
        join(project, ".git"),
        join(home, "pool"),
        join(home, "template"),
      );
      db.close();
      expect(createCleanupPlan(await audit(), config).actions).toEqual([]);
      expect(
        await revalidateArtifactRemove(action, home, config, { cwd: project, processProbe }),
      ).toMatchObject({
        status: "stale",
        diagnostic: { code: "OPENCLAW_ARTIFACT_PROTECTED" },
      });
    },
  );

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
