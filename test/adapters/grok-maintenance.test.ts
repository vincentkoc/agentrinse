import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GROK_SOURCE_CONTRACT,
  inspectGrokOwnerContract,
  parseGrokVersion,
} from "../../src/adapters/grok-maintenance.js";
import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-grok-maintenance-")),
    now: new Date("2026-07-29T00:00:00.000Z"),
    auditId: "audit-grok-maintenance",
  };
}

describe("Grok owner contract reporting", () => {
  it("parses the current channel-aware version format", () => {
    expect(parseGrokVersion("grok 0.2.112 (abc1234) [stable]\n")).toBe("0.2.112");
    expect(parseGrokVersion("grok 0.2.113-alpha.1 (def5678) [alpha]\n")).toBe("0.2.113-alpha.1");
    expect(parseGrokVersion("0.2.112\n")).toBeUndefined();
  });

  it("records an unavailable executable without inventing installed support", async () => {
    const facts = await inspectGrokOwnerContract({}, async () => {
      throw new Error("missing");
    });

    expect(facts).toMatchObject({
      installedVersionStatus: "unavailable",
      inventoryScope: "owner-root",
      mutationAvailable: false,
      refusalCode: "grok-cleanup-owner-contract-unavailable",
    });
    expect(facts).not.toHaveProperty("installedVersion");
  });

  it("inventories confirmed subpaths only for the exact inspected version", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "grok-data");
    const expectedResources = [
      ["sessions", "Grok Build sessions"],
      ["logs", "Grok Build logs"],
      ["memory", "Grok Build memory"],
      ["worktrees", "Grok Build managed worktrees"],
      ["marketplace-cache", "Grok Build marketplace cache"],
      ["downloads", "Grok Build downloaded runtimes"],
    ] as const;
    for (const [relativePath] of expectedResources) {
      await mkdir(join(root, relativePath), { recursive: true });
      await writeFile(join(root, relativePath, "fixture"), "synthetic\n");
    }
    await writeFile(join(root, "config.toml"), "protected = true\n");
    await mkdir(join(root, "plugins"));
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.grok, {
      root,
      environment: {},
      measureBytes: true,
      maxEntries: 100,
      runGrokVersion: async () => `grok ${GROK_SOURCE_CONTRACT.version} (abc1234) [stable]\n`,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );

    expect(collection.resources.map((resource) => resource.resource.displayName)).toEqual(
      expectedResources.map(([, displayName]) => displayName),
    );
    expect(collection.resources.every((resource) => resource.measuredBytes === 10)).toBe(true);
    expect(
      collection.resources.every(
        (resource) =>
          resource.facts.ownerContract !== undefined &&
          resource.facts.ownerContract !== null &&
          (resource.facts.ownerContract as Record<string, unknown>).installedVersionStatus ===
            "exact",
      ),
    ).toBe(true);
    expect(
      findings.every(
        (finding) =>
          finding.state === "protected" &&
          finding.confidence === "high" &&
          finding.candidateActions.length === 0 &&
          finding.roots[0]?.code === "grok-cleanup-owner-contract-unavailable",
      ),
    ).toBe(true);
    expect(
      collection.resources.some((resource) => resource.resource.path?.endsWith("config.toml")),
    ).toBe(false);
    expect(
      collection.resources.some((resource) => resource.resource.path?.endsWith("plugins")),
    ).toBe(false);
  });

  it("falls back to one protected owner-root finding when versions differ", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "grok-data");
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "config.toml"), "protected = true\n");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.grok, {
      root,
      environment: {},
      measureBytes: true,
      maxEntries: 100,
      runGrokVersion: async () => "grok 0.2.111 (abc1234) [stable]\n",
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(context, collection.resources[0]!);

    expect(collection.resources).toHaveLength(1);
    expect(collection.resources[0]?.resource).toMatchObject({
      displayName: "Grok Build data",
      kind: "agent-home",
      path: root,
    });
    expect(collection.resources[0]?.facts.ownerContract).toMatchObject({
      installedVersion: "0.2.111",
      installedVersionStatus: "different",
      sourceVersion: GROK_SOURCE_CONTRACT.version,
      inventoryScope: "owner-root",
    });
    expect(finding).toMatchObject({
      state: "protected",
      confidence: "unknown",
      candidateActions: [],
    });
    expect(finding.roots.map((rootEvidence) => rootEvidence.code)).toEqual([
      "grok-cleanup-owner-contract-unavailable",
      "provider-owned-report-only",
    ]);
  });
});
