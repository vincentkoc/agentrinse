import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import {
  CLAUDE_DEBUG_LOG_POLICY_ID,
  isClaudeDebugLogRelativePath,
} from "../../src/core/provider-file-policy.js";

const NOW = new Date("2026-07-25T00:00:00.000Z");

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-claude-debug-")),
    now: NOW,
    auditId: "audit-claude-debug",
  };
}

async function writeDatedFile(path: string, value: string, date: Date): Promise<void> {
  await writeFile(path, value);
  await utimes(path, date, date);
}

describe("Claude debug cleanup", () => {
  it("proposes recoverable quarantine only for direct old debug text files", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const debug = join(root, "debug");
    await mkdir(debug, { recursive: true });
    await writeDatedFile(
      join(debug, "old-session.txt"),
      "synthetic old debug output\n",
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await writeDatedFile(
      join(debug, "recent-session.txt"),
      "synthetic recent debug output\n",
      new Date("2026-07-20T00:00:00.000Z"),
    );
    await writeDatedFile(
      join(debug, "transcript.jsonl"),
      '{"synthetic":"transcript"}\n',
      new Date("2026-06-01T00:00:00.000Z"),
    );
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
      environment: {},
      measureBytes: true,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const exactLogs = collection.resources.filter(
      (resource) => resource.facts.policyId === CLAUDE_DEBUG_LOG_POLICY_ID,
    );
    const finding = await adapter.classify(context, exactLogs[0]!);

    expect(exactLogs).toHaveLength(1);
    expect(exactLogs[0]?.resource.path).toBe(await realpath(join(debug, "old-session.txt")));
    expect(finding).toMatchObject({
      state: "eligible",
      confidence: "certain",
      candidateActions: [
        {
          type: "provider.file-quarantine",
          adapter: "claude",
          policyId: CLAUDE_DEBUG_LOG_POLICY_ID,
          risk: "recoverable",
          expectedReclaimBytes: 0,
          quarantineTtlMinutes: 7 * 24 * 60,
        },
      ],
    });
  });

  it("fails closed when the debug directory exceeds the entry budget", async () => {
    const context = await fixtureContext();
    const debug = join(context.home, ".claude", "debug");
    await mkdir(debug, { recursive: true });
    await writeFile(join(debug, "one.txt"), "one");
    await writeFile(join(debug, "two.txt"), "two");
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
      environment: {},
      measureBytes: false,
      maxEntries: 1,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);

    expect(collection.resources.some((resource) => resource.facts.policyId !== undefined)).toBe(
      false,
    );
    expect(collection.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CLAUDE_DEBUG_ENUMERATION_TRUNCATED" }),
    );
  });

  it("does not follow a symlinked debug directory", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const target = await mkdtemp(join(tmpdir(), "agentrinse-claude-debug-target-"));
    await mkdir(root);
    await writeFile(join(target, "old-session.txt"), "outside");
    await symlink(target, join(root, "debug"));
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
      environment: {},
      measureBytes: false,
      maxEntries: 100,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);

    expect(collection.resources.some((resource) => resource.facts.policyId !== undefined)).toBe(
      false,
    );
  });

  it("matches only one direct Claude debug text file", () => {
    expect(isClaudeDebugLogRelativePath("debug/session.txt")).toBe(true);
    expect(isClaudeDebugLogRelativePath("debug\\session.txt")).toBe(true);
    expect(isClaudeDebugLogRelativePath("debug/session.jsonl")).toBe(false);
    expect(isClaudeDebugLogRelativePath("debug/nested/session.txt")).toBe(false);
    expect(isClaudeDebugLogRelativePath("projects/session.txt")).toBe(false);
  });
});
