import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-opencode-maintenance-")),
    now: new Date("2026-07-29T00:00:00.000Z"),
    auditId: "audit-opencode-maintenance",
  };
}

describe("OpenCode native maintenance reporting", () => {
  it("reports owner snapshot GC and server-log retention without creating actions", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "opencode-data");
    await mkdir(join(root, "log"), { recursive: true });
    await mkdir(join(root, "snapshot", "project", "worktree"), { recursive: true });
    await writeFile(join(root, "opencode.db"), "synthetic\n");
    await writeFile(join(root, "log", "opencode.log"), "synthetic\n");
    await writeFile(join(root, "snapshot", "project", "worktree", "HEAD"), "synthetic\n");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.opencode, {
      root,
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const database = collection.resources.find(
      (resource) => resource.resource.displayName === "OpenCode database",
    );
    const logs = collection.resources.find(
      (resource) => resource.resource.displayName === "OpenCode logs",
    );
    const snapshots = collection.resources.find(
      (resource) => resource.resource.displayName === "OpenCode snapshots",
    );
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );

    expect(database?.facts.nativeMaintenance).toBeUndefined();
    expect(logs?.facts.nativeMaintenance).toEqual({
      provider: "opencode",
      kind: "server-log-retention",
      sourceVersion: "1.18.9",
      fileName: "opencode.log",
      writeMode: "append",
      automaticRetention: false,
      desktopRetentionIsSeparate: true,
      installedSupportKnown: false,
    });
    expect(snapshots?.facts.nativeMaintenance).toEqual({
      provider: "opencode",
      kind: "snapshot-gc",
      sourceVersion: "1.18.9",
      pruneAgeDays: 7,
      startupDelayMinutes: 1,
      intervalHours: 1,
      snapshotsMustBeEnabled: true,
      installedSupportKnown: false,
    });
    expect(findings).toHaveLength(3);
    expect(
      findings.every(
        (finding) =>
          finding.state === "protected" &&
          finding.candidateActions.length === 0 &&
          finding.roots.some((rootEvidence) => rootEvidence.code === "provider-owned-report-only"),
      ),
    ).toBe(true);
    expect(
      findings.find((finding) => finding.resource.displayName === "OpenCode logs")?.roots[0]?.code,
    ).toBe("opencode-server-log-retention-version-unverified");
    expect(
      findings.find((finding) => finding.resource.displayName === "OpenCode snapshots")?.roots[0]
        ?.code,
    ).toBe("opencode-native-snapshot-gc-version-unverified");
  });
});
