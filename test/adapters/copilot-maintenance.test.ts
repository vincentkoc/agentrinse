import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-copilot-maintenance-")),
    now: new Date("2026-07-27T00:00:00.000Z"),
    auditId: "audit-copilot-maintenance",
  };
}

describe("Copilot native maintenance reporting", () => {
  it("reports native session and process-log maintenance without creating actions", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "copilot-state");
    await mkdir(join(root, "session-state"), { recursive: true });
    await mkdir(join(root, "logs", "extensions"), { recursive: true });
    await writeFile(join(root, "session-state", "session.jsonl"), "synthetic\n");
    await writeFile(join(root, "logs", "process-1-2.log"), "synthetic\n");
    await writeFile(join(root, "logs", "extensions", "extension.log"), "synthetic\n");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.copilot, {
      environment: { COPILOT_HOME: root },
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const sessions = collection.resources.find(
      (resource) => resource.resource.displayName === "Copilot CLI session state",
    );
    const logs = collection.resources.find(
      (resource) => resource.resource.displayName === "Copilot CLI logs",
    );
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );

    expect(sessions?.facts.nativeMaintenance).toEqual({
      provider: "copilot",
      kind: "session-prune",
      command: "/session prune --older-than <days> [--dry-run] [--include-named]",
      localOnly: true,
      dryRunSupported: true,
      currentSessionExcluded: true,
      namedSessionsExcludedByDefault: true,
      installedSupportKnown: false,
    });
    expect(logs?.facts.nativeMaintenance).toEqual({
      provider: "copilot",
      kind: "process-log-retention",
      introducedVersion: "1.0.52",
      filePattern: "process-*.log",
      maxAgeDays: 7,
      maxFiles: 50,
      extensionLogsExcluded: true,
      installedSupportKnown: false,
    });
    expect(findings).toHaveLength(2);
    expect(
      findings.every(
        (finding) =>
          finding.state === "protected" &&
          finding.confidence === "unknown" &&
          finding.candidateActions.length === 0,
      ),
    ).toBe(true);
    expect(
      findings.every(
        (finding) => finding.roots[0]?.code === "copilot-native-maintenance-version-unverified",
      ),
    ).toBe(true);
  });
});
