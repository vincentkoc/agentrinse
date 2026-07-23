import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAuditAdapters } from "../../src/adapters/registry.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
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
});
