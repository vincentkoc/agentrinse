import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import {
  isZedRotatedLogRelativePath,
  ZED_ROTATED_LOG_POLICY_ID,
} from "../../src/core/provider-file-policy.js";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const OLD = new Date("2026-06-01T00:00:00.000Z");

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-zed-logs-")),
    now: NOW,
    auditId: "audit-zed-logs",
  };
}

async function writeDatedFile(path: string, value: string, date: Date): Promise<void> {
  await writeFile(path, value);
  await utimes(path, date, date);
}

function adapter(options: { root?: string; platform?: NodeJS.Platform } = {}) {
  return new ProviderAuditAdapter(PROVIDER_SPECS.zed, {
    environment: {},
    measureBytes: true,
    maxEntries: 100,
    ...options,
  });
}

describe("Zed rotated-log cleanup", () => {
  it("proposes recoverable quarantine only for the old rotated macOS log", async () => {
    const context = await fixtureContext();
    const dataRoot = join(context.home, "Library", "Application Support", "Zed");
    const logRoot = join(context.home, "Library", "Logs", "Zed");
    await mkdir(dataRoot, { recursive: true });
    await mkdir(logRoot, { recursive: true });
    await writeDatedFile(join(logRoot, "Zed.log.old"), "synthetic rotated log\n", OLD);
    await writeDatedFile(join(logRoot, "Zed.log"), "synthetic active log\n", OLD);
    await writeDatedFile(join(logRoot, "Zed.log.old.backup"), "synthetic neighbor\n", OLD);
    const zed = adapter({ platform: "darwin" });

    const probe = await zed.probe(context);
    const collection = await zed.collect(context, probe);
    const exactLogs = collection.resources.filter(
      (resource) => resource.facts.policyId === ZED_ROTATED_LOG_POLICY_ID,
    );
    const finding = await zed.classify(context, exactLogs[0]!);

    expect(exactLogs).toHaveLength(1);
    expect(exactLogs[0]).toMatchObject({
      resource: {
        kind: "agent-log-store",
        path: await realpath(join(logRoot, "Zed.log.old")),
      },
    });
    expect(
      collection.resources.some(
        (resource) =>
          resource.resource.path?.endsWith("Zed.log") ||
          resource.resource.path?.endsWith("Zed.log.old.backup"),
      ),
    ).toBe(false);
    expect(finding).toMatchObject({
      state: "eligible",
      confidence: "certain",
      roots: [{ code: "zed-rotated-log-owner-contract" }],
      candidateActions: [
        {
          type: "provider.file-quarantine",
          adapter: "zed",
          policyId: ZED_ROTATED_LOG_POLICY_ID,
          risk: "recoverable",
          expectedReclaimBytes: 0,
          quarantineTtlMinutes: 7 * 24 * 60,
        },
      ],
    });
  });

  it("finds the external macOS log when the user-data root is absent", async () => {
    const context = await fixtureContext();
    const logRoot = join(context.home, "Library", "Logs", "Zed");
    await mkdir(logRoot, { recursive: true });
    await writeDatedFile(join(logRoot, "Zed.log.old"), "synthetic rotated log\n", OLD);
    const zed = adapter({ platform: "darwin" });

    const probe = await zed.probe(context);
    const collection = await zed.collect(context, probe);

    expect(probe.status).toBe("absent");
    expect(collection.resources).toHaveLength(1);
    expect(collection.resources[0]?.facts.policyId).toBe(ZED_ROTATED_LOG_POLICY_ID);
  });

  it("uses the logs directory under an explicit Zed data root", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "custom-zed");
    const logs = join(root, "logs");
    await mkdir(logs, { recursive: true });
    await writeDatedFile(join(logs, "Zed.log.old"), "synthetic custom rotated log\n", OLD);
    const zed = adapter({ root, platform: "darwin" });

    const probe = await zed.probe(context);
    const collection = await zed.collect(context, probe);
    const rotatedLog = collection.resources.find(
      (resource) => resource.facts.policyId === ZED_ROTATED_LOG_POLICY_ID,
    );

    expect(probe).toMatchObject({ status: "available", root });
    expect(rotatedLog?.resource.path).toBe(await realpath(join(logs, "Zed.log.old")));
  });

  it("does not collect a recent rotated log", async () => {
    const context = await fixtureContext();
    const root = join(context.home, "Library", "Application Support", "Zed");
    const logs = join(context.home, "Library", "Logs", "Zed");
    await mkdir(root, { recursive: true });
    await mkdir(logs, { recursive: true });
    await writeDatedFile(
      join(logs, "Zed.log.old"),
      "synthetic recent rotated log\n",
      new Date("2026-07-20T00:00:00.000Z"),
    );
    const zed = adapter({ platform: "darwin" });

    const probe = await zed.probe(context);
    const collection = await zed.collect(context, probe);

    expect(
      collection.resources.some(
        (resource) => resource.facts.policyId === ZED_ROTATED_LOG_POLICY_ID,
      ),
    ).toBe(false);
  });

  it("does not follow a symlinked log root or rotated log", async () => {
    const rootContext = await fixtureContext();
    const dataRoot = join(rootContext.home, "Library", "Application Support", "Zed");
    const logsParent = join(rootContext.home, "Library", "Logs");
    const outside = await mkdtemp(join(tmpdir(), "agentrinse-zed-logs-target-"));
    await mkdir(dataRoot, { recursive: true });
    await mkdir(logsParent, { recursive: true });
    await writeDatedFile(join(outside, "Zed.log.old"), "outside\n", OLD);
    await symlink(outside, join(logsParent, "Zed"));
    const zed = adapter({ platform: "darwin" });

    const rootProbe = await zed.probe(rootContext);
    const rootCollection = await zed.collect(rootContext, rootProbe);

    expect(rootCollection.resources).toHaveLength(1);
    expect(rootCollection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "ZED_LOG_ROOT_UNSAFE" }),
    );

    const fileContext = await fixtureContext();
    const fileDataRoot = join(fileContext.home, "Library", "Application Support", "Zed");
    const fileLogRoot = join(fileContext.home, "Library", "Logs", "Zed");
    const outsideFile = join(fileContext.home, "outside.log");
    await mkdir(fileDataRoot, { recursive: true });
    await mkdir(fileLogRoot, { recursive: true });
    await writeDatedFile(outsideFile, "outside\n", OLD);
    await symlink(outsideFile, join(fileLogRoot, "Zed.log.old"));

    const fileProbe = await zed.probe(fileContext);
    const fileCollection = await zed.collect(fileContext, fileProbe);

    expect(
      fileCollection.resources.some(
        (resource) => resource.facts.policyId === ZED_ROTATED_LOG_POLICY_ID,
      ),
    ).toBe(false);
  });

  it("matches only the exact rotated log filename", () => {
    expect(isZedRotatedLogRelativePath("Zed.log.old")).toBe(true);
    expect(isZedRotatedLogRelativePath("Zed.log")).toBe(false);
    expect(isZedRotatedLogRelativePath("Zed.log.old.backup")).toBe(false);
    expect(isZedRotatedLogRelativePath(join("nested", "Zed.log.old"))).toBe(false);
  });
});
