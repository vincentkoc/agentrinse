import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

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

  it.each(["codex", "claude", "cursor", "copilot", "zed", "opencode", "grok"] as const)(
    "defines a %s adapter root inside the synthetic home",
    (id) => {
      const root = PROVIDER_SPECS[id].defaultRoot("/fixture/home", "darwin");

      expect(root.startsWith("/fixture/home/")).toBe(true);
    },
  );
});
