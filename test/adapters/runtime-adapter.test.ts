import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { RuntimeAuditAdapter } from "../../src/adapters/runtime/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-runtime-")),
    now: new Date("2026-07-24T00:00:00.000Z"),
    auditId: "audit-runtime",
  };
}

describe("RuntimeAuditAdapter", () => {
  it("inventories the documented Claude native version layout", async () => {
    const context = await fixtureContext();
    const bin = join(context.home, ".local", "bin");
    const versions = join(context.home, ".local", "share", "claude", "versions");
    const oldVersion = join(versions, "2.1.200");
    const activeVersion = join(versions, "2.1.201");
    await mkdir(bin, { recursive: true });
    await mkdir(versions, { recursive: true });
    await writeFile(oldVersion, "old");
    await writeFile(activeVersion, "active");
    await chmod(oldVersion, 0o700);
    await chmod(activeVersion, 0o700);
    await symlink(activeVersion, join(bin, "claude"));
    const adapter = new RuntimeAuditAdapter({
      environment: { PATH: join(context.home, "missing-bin") },
      platform: "linux",
      runVersion: async () => {
        throw new Error("native Claude versions do not need execution");
      },
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );

    expect(probe.status).toBe("available");
    expect(collection.resources).toHaveLength(2);
    expect(collection.resources.map((resource) => resource.facts.version)).toEqual([
      "2.1.200",
      "2.1.201",
    ]);
    expect(collection.resources.map((resource) => resource.facts.selected)).toEqual([false, true]);
    expect(findings.every((finding) => finding.state === "protected")).toBe(true);
    expect(findings.every((finding) => finding.candidateActions.length === 0)).toBe(true);
  });

  it("reports a generic selected executable without guessing its installer", async () => {
    const context = await fixtureContext();
    const bin = join(context.home, "bin");
    const executable = join(bin, "codex");
    await mkdir(bin);
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o700);
    const adapter = new RuntimeAuditAdapter({
      environment: { PATH: bin },
      platform: "linux",
      runVersion: async () => "codex-cli 0.143.0\n",
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);

    expect(collection.resources).toHaveLength(1);
    expect(collection.resources[0]?.facts).toMatchObject({
      tool: "codex",
      selected: true,
      version: "codex-cli 0.143.0",
      installManager: "unknown",
      reportOnly: true,
    });
    expect(collection.diagnostics).toEqual([]);
  });

  it("skips non-executable Unix PATH entries", async () => {
    const context = await fixtureContext();
    const shadowBin = join(context.home, "shadow-bin");
    const selectedBin = join(context.home, "selected-bin");
    const shadow = join(shadowBin, "codex");
    const selected = join(selectedBin, "codex");
    await mkdir(shadowBin);
    await mkdir(selectedBin);
    await writeFile(shadow, "#!/bin/sh\n");
    await writeFile(selected, "#!/bin/sh\n");
    await chmod(shadow, 0o600);
    await chmod(selected, 0o700);
    const adapter = new RuntimeAuditAdapter({
      environment: { PATH: `${shadowBin}${delimiter}${selectedBin}` },
      platform: "linux",
      runVersion: async (executable) => {
        expect(executable).toBe(selected);
        return "codex-cli 0.143.0\n";
      },
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);

    expect(collection.resources).toHaveLength(1);
    expect(collection.resources[0]?.facts.launcherPath).toBe(selected);
  });

  it("reports an absent isolated PATH without diagnostics", async () => {
    const context = await fixtureContext();
    const adapter = new RuntimeAuditAdapter({
      environment: { PATH: join(context.home, "missing") },
      platform: "linux",
    });

    const probe = await adapter.probe(context);

    expect(probe.status).toBe("absent");
    expect(probe.diagnostics).toEqual([]);
  });
});
