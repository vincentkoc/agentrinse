import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAuditAdapters } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AuditAdapter } from "../../src/contracts/adapter.js";
import { runAudit } from "../../src/core/audit.js";

describe("runAudit", () => {
  it("returns a stable report over a synthetic home", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-"));
    const sessions = join(home, ".copilot", "session-state");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "session.json"), "{}");
    const now = () => new Date("2026-07-23T01:02:03.000Z");

    const report = await runAudit({
      home,
      config: DEFAULT_CONFIG,
      adapters: createAuditAdapters(DEFAULT_CONFIG, "darwin"),
      now,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.startedAt).toBe("2026-07-23T01:02:03.000Z");
    expect(report.probes).toHaveLength(7);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.resource.adapter).toBe("copilot");
    expect(report.findings[0]?.state).toBe("protected");
  });

  it("does not instantiate disabled adapters", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.grok = { enabled: false };

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).not.toContain("grok");
  });

  it("instantiates only explicitly selected providers", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.git = { enabled: true, root: "/tmp/agentrinse-git-fixture" };
    config.adapters.docker = { enabled: true };
    config.adapters.runtime = { enabled: true };
    config.artifacts.projects = [
      {
        root: "/tmp/agentrinse-artifact-project",
        names: ["node_modules"],
      },
    ];

    expect(
      createAuditAdapters(config, "linux", {
        providers: ["cursor", "copilot", "opencode"],
      }).map((adapter) => adapter.id),
    ).toEqual(["cursor", "copilot", "opencode"]);
  });

  it("rejects invalid direct provider selections", () => {
    expect(() => createAuditAdapters(DEFAULT_CONFIG, "linux", { providers: [] })).toThrow(
      "must not be empty",
    );
    expect(() =>
      createAuditAdapters(DEFAULT_CONFIG, "linux", {
        providers: ["cursor", "cursor"],
      }),
    ).toThrow("duplicate provider ID");
    expect(() =>
      createAuditAdapters(DEFAULT_CONFIG, "linux", {
        providers: ["git" as never],
      }),
    ).toThrow("unknown provider ID");
  });

  it("honors configured roots when selection overrides a disabled provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-provider-select-home-"));
    const cursorRoot = await mkdtemp(join(tmpdir(), "agentrinse-provider-select-cursor-"));
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.cursor = { enabled: false, root: cursorRoot };

    const report = await runAudit({
      home,
      config,
      adapters: createAuditAdapters(config, "darwin", { providers: ["cursor"] }),
    });

    expect(report.probes).toEqual([
      expect.objectContaining({
        adapter: "cursor",
        root: cursorRoot,
        status: "available",
      }),
    ]);
  });

  it("adds Git only when explicitly enabled", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.git = {
      enabled: true,
      root: "/tmp/agentrinse-git-fixture",
    };

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).toContain("git");
  });

  it("resolves Git roots before classifying mutable artifacts", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.git = {
      enabled: true,
      root: "/tmp/agentrinse-git-fixture",
    };
    config.artifacts.projects = [
      {
        root: "/tmp/agentrinse-git-fixture",
        names: ["node_modules"],
      },
    ];

    const adapters = createAuditAdapters(config).map((adapter) => adapter.id);
    expect(adapters.indexOf("git")).toBeLessThan(adapters.indexOf("artifacts"));
  });

  it("runs providers once and Git once per explicit fleet repository", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.git = {
      enabled: true,
      root: "/tmp/agentrinse-configured-repo",
    };
    config.artifacts.projects = [
      {
        root: "/tmp/agentrinse-artifact-project",
        names: ["node_modules"],
      },
    ];

    const adapters = createAuditAdapters(config, "linux", {
      gitRepositories: [{ root: "/tmp/agentrinse-repo-a" }, { root: "/tmp/agentrinse-repo-b" }],
    }).map((adapter) => adapter.id);

    expect(adapters.filter((id) => id === "git")).toHaveLength(2);
    expect(adapters.filter((id) => id === "codex")).toHaveLength(1);
    expect(adapters.filter((id) => id === "claude")).toHaveLength(1);
    expect(adapters.filter((id) => id === "artifacts")).toHaveLength(1);
  });

  it("adds Docker only when explicitly enabled", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.docker = { enabled: true };

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).toContain("docker");
  });

  it("adds runtime inventory only when explicitly enabled", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.runtime = { enabled: true };

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).toContain("runtime");
  });

  it("adds artifacts only when explicit projects are configured", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.artifacts.projects = [
      {
        root: "/tmp/agentrinse-artifact-project",
        names: ["node_modules"],
      },
    ];

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).toContain("artifacts");
  });

  it("streams collection diagnostics even when no resources are discovered", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-diagnostic-"));
    const events: string[] = [];
    const adapter: AuditAdapter = {
      id: "fixture",
      probe: async () => ({
        adapter: "fixture",
        status: "available",
        detail: "fixture adapter is available",
        diagnostics: [],
      }),
      collect: async () => ({
        resources: [],
        diagnostics: [
          {
            severity: "warning",
            code: "FIXTURE_COLLECTION_WARNING",
            message: "collection completed with partial visibility",
            adapter: "fixture",
          },
        ],
      }),
      classify: async () => {
        throw new Error("classify must not run without resources");
      },
    };

    const report = await runAudit({
      home,
      config: DEFAULT_CONFIG,
      adapters: [adapter],
      onEvent: (event) => events.push(event.type),
    });

    expect(report.diagnostics).toHaveLength(1);
    expect(events).toEqual([
      "phase.started",
      "phase.completed",
      "adapter.probed",
      "phase.started",
      "phase.completed",
      "diagnostic.reported",
    ]);
  });

  it("returns a protected partial finding when classification exceeds its deadline", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-deadline-"));
    const events: Array<{ type: string; data: unknown }> = [];
    const adapter: AuditAdapter = {
      id: "fixture",
      probe: async () => ({
        adapter: "fixture",
        status: "available",
        detail: "fixture adapter is available",
        diagnostics: [],
      }),
      collect: async () => ({
        resources: [
          {
            resource: {
              id: "fixture:slow-resource",
              adapter: "fixture",
              kind: "agent-cache",
              canonicalKey: "fixture:slow-resource",
              displayName: "Slow resource",
              path: join(home, "slow-resource"),
            },
            observedAt: "2026-09-08T00:00:00.000Z",
            exists: true,
            measuredBytes: 123,
            facts: { reportOnly: true },
          },
        ],
        diagnostics: [],
      }),
      classify: async () => new Promise(() => {}),
    };

    const report = await runAudit({
      home,
      config: DEFAULT_CONFIG,
      adapters: [adapter],
      phaseTimeoutMs: 10,
      onEvent: (event) => events.push(event),
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({ id: "fixture:slow-resource" }),
        state: "unknown",
        confidence: "unknown",
        candidateActions: [],
        facts: expect.objectContaining({
          partial: true,
          incompletePhase: "classify",
        }),
      }),
    ]);
    expect(report.findings[0]?.estimatedReclaimBytes).toBeUndefined();
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "AUDIT_PHASE_DEADLINE_EXCEEDED",
        resourceId: "fixture:slow-resource",
      }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "phase.started",
          data: expect.objectContaining({
            adapter: "fixture",
            phase: "classify",
            deadlineMs: 10,
          }),
        }),
        expect.objectContaining({
          type: "phase.completed",
          data: expect.objectContaining({
            adapter: "fixture",
            phase: "classify",
            status: "deadline",
            elapsedMs: expect.any(Number),
          }),
        }),
      ]),
    );
  });

  it("returns a degraded probe when probing exceeds its deadline", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-deadline-"));
    let collected = false;
    const adapter: AuditAdapter = {
      id: "fixture",
      probe: async () => new Promise(() => {}),
      collect: async () => {
        collected = true;
        return { resources: [], diagnostics: [] };
      },
      classify: async () => {
        throw new Error("classify must not run");
      },
    };

    const report = await runAudit({
      home,
      config: DEFAULT_CONFIG,
      adapters: [adapter],
      phaseTimeoutMs: 10,
    });

    expect(collected).toBe(false);
    expect(report.probes).toEqual([
      expect.objectContaining({
        adapter: "fixture",
        status: "degraded",
        diagnostics: [
          expect.objectContaining({
            code: "AUDIT_PHASE_DEADLINE_EXCEEDED",
          }),
        ],
      }),
    ]);
    expect(report.findings).toEqual([]);
  });

  it("returns a degraded partial report when collection exceeds its deadline", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-deadline-"));
    let classified = false;
    const adapter: AuditAdapter = {
      id: "fixture",
      probe: async () => ({
        adapter: "fixture",
        status: "available",
        detail: "fixture adapter is available",
        diagnostics: [],
      }),
      collect: async () => new Promise(() => {}),
      classify: async () => {
        classified = true;
        throw new Error("classify must not run after a collection deadline");
      },
    };

    const report = await runAudit({
      home,
      config: DEFAULT_CONFIG,
      adapters: [adapter],
      phaseTimeoutMs: 10,
    });

    expect(classified).toBe(false);
    expect(report.probes).toEqual([
      expect.objectContaining({
        adapter: "fixture",
        status: "available",
      }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "AUDIT_PHASE_DEADLINE_EXCEEDED",
        adapter: "fixture",
        message: expect.stringContaining("collect phase"),
      }),
    ]);
  });
});
