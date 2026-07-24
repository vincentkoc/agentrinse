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

  it("adds Git only when explicitly enabled", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.git = {
      enabled: true,
      root: "/tmp/agentrinse-git-fixture",
    };

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).toContain("git");
  });

  it("adds Docker only when explicitly enabled", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.adapters.docker = { enabled: true };

    expect(createAuditAdapters(config).map((adapter) => adapter.id)).toContain("docker");
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
    expect(events).toEqual(["adapter.probed", "diagnostic.reported"]);
  });
});
