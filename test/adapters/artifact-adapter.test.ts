import {
  mkdir,
  mkdtemp,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactAuditAdapter } from "../../src/adapters/artifacts/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import type { ProcessOwnershipResult } from "../../src/core/process-ownership.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

async function fixture(
  ownership: ProcessOwnershipResult = { status: "idle", matches: [] },
) {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-artifact-"));
  const projectRoot = join(home, "project");
  const artifact = join(projectRoot, "node_modules");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "package.json"), "synthetic");
  await utimes(artifact, new Date(0), new Date(0));

  const context: AuditContext = {
    home,
    now: NOW,
    auditId: "audit-artifact",
  };
  const adapter = new ArtifactAuditAdapter(
    {
      projects: [{ root: projectRoot, names: ["node_modules"] }],
      minAgeMinutes: 60,
      minBytes: 1,
      processCheck: "required",
      measureBytes: true,
      maxEntries: 100,
    },
    async () => ownership,
  );
  return { home, projectRoot, artifact, context, adapter };
}

describe("ArtifactAuditAdapter", () => {
  it("proposes an exact safe action for an idle old artifact", async () => {
    const { context, adapter } = await fixture();
    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(
      context,
      collection.resources[0]!,
    );

    expect(finding.state).toBe("eligible");
    expect(finding.candidateActions[0]).toMatchObject({
      type: "artifacts.remove",
      risk: "safe",
      expectedReclaimBytes: 9,
    });
  });

  it("protects an artifact owned by a live process", async () => {
    const { context, adapter, artifact } = await fixture({
      status: "busy",
      matches: [{ pid: 42, source: "cwd", path: "/fixture" }],
    });
    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(
      context,
      collection.resources[0]!,
    );

    expect(artifact).toContain("node_modules");
    expect(finding.state).toBe("protected");
    expect(finding.roots[0]?.code).toBe("live-process");
    expect(finding.candidateActions).toEqual([]);
  });

  it("blocks symlinked artifacts", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-artifact-"));
    const projectRoot = join(home, "project");
    const target = join(home, "outside");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(target);
    await symlink(target, join(projectRoot, "dist"));
    const context: AuditContext = {
      home,
      now: NOW,
      auditId: "audit-artifact",
    };
    const adapter = new ArtifactAuditAdapter(
      {
        projects: [{ root: projectRoot, names: ["dist"] }],
        minAgeMinutes: 0,
        minBytes: 0,
        processCheck: "required",
        measureBytes: true,
        maxEntries: 100,
      },
      async () => ({ status: "idle", matches: [] }),
    );

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const finding = await adapter.classify(
      context,
      collection.resources[0]!,
    );

    expect(finding.state).toBe("blocked");
    expect(finding.warnings[0]?.code).toBe("ARTIFACT_SYMLINK_BLOCKED");
  });

  it("rejects project roots outside the audited home", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-artifact-home-"));
    const outside = await mkdtemp(
      join(tmpdir(), "agentrinse-artifact-outside-"),
    );
    const context: AuditContext = {
      home,
      now: NOW,
      auditId: "audit-artifact",
    };
    const adapter = new ArtifactAuditAdapter({
      projects: [{ root: outside, names: ["dist"] }],
      minAgeMinutes: 0,
      minBytes: 0,
      processCheck: "required",
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);

    expect(probe.status).toBe("degraded");
    expect(probe.diagnostics[0]?.code).toBe(
      "ARTIFACT_PROJECT_OUTSIDE_HOME",
    );
  });
});
