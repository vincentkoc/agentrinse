import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import {
  CLAUDE_CHANGELOG_CACHE_POLICY_ID,
  isClaudeChangelogCacheRelativePath,
} from "../../src/core/provider-file-policy.js";

const NOW = new Date("2026-07-27T00:00:00.000Z");

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-claude-cache-")),
    now: NOW,
    auditId: "audit-claude-cache",
  };
}

async function writeDatedFile(path: string, value: string, date: Date): Promise<void> {
  await writeFile(path, value);
  await utimes(path, date, date);
}

function adapter(): ProviderAuditAdapter {
  return new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
    environment: {},
    measureBytes: true,
    maxEntries: 100,
  });
}

describe("Claude changelog cache cleanup", () => {
  it("proposes recoverable quarantine only for the exact old changelog cache", async () => {
    const context = await fixtureContext();
    const cache = join(context.home, ".claude", "cache");
    await mkdir(cache, { recursive: true });
    await writeDatedFile(
      join(cache, "changelog.md"),
      "synthetic release notes cache\n",
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await writeDatedFile(
      join(cache, "my-closed-issues.json"),
      '{"synthetic":"undocumented-neighbor"}\n',
      new Date("2026-06-01T00:00:00.000Z"),
    );
    const claude = adapter();

    const probe = await claude.probe(context);
    const collection = await claude.collect(context, probe);
    const exactCaches = collection.resources.filter(
      (resource) => resource.facts.policyId === CLAUDE_CHANGELOG_CACHE_POLICY_ID,
    );
    const finding = await claude.classify(context, exactCaches[0]!);

    expect(exactCaches).toHaveLength(1);
    expect(exactCaches[0]).toMatchObject({
      resource: {
        kind: "agent-cache",
        displayName: "Claude changelog cache",
        path: await realpath(join(cache, "changelog.md")),
      },
    });
    expect(
      collection.resources.some((resource) =>
        resource.resource.path?.endsWith("my-closed-issues.json"),
      ),
    ).toBe(false);
    expect(finding).toMatchObject({
      state: "eligible",
      confidence: "certain",
      roots: [{ code: "claude-changelog-cache-owner-contract" }],
      candidateActions: [
        {
          type: "provider.file-quarantine",
          adapter: "claude",
          policyId: CLAUDE_CHANGELOG_CACHE_POLICY_ID,
          risk: "recoverable",
          expectedReclaimBytes: 0,
          quarantineTtlMinutes: 7 * 24 * 60,
        },
      ],
    });
  });

  it("does not collect a recent changelog cache", async () => {
    const context = await fixtureContext();
    const cache = join(context.home, ".claude", "cache");
    await mkdir(cache, { recursive: true });
    await writeDatedFile(
      join(cache, "changelog.md"),
      "synthetic recent release notes cache\n",
      new Date("2026-07-20T00:00:00.000Z"),
    );
    const claude = adapter();

    const probe = await claude.probe(context);
    const collection = await claude.collect(context, probe);

    expect(
      collection.resources.some(
        (resource) => resource.facts.policyId === CLAUDE_CHANGELOG_CACHE_POLICY_ID,
      ),
    ).toBe(false);
  });

  it("does not follow a symlinked cache directory or changelog file", async () => {
    const directoryContext = await fixtureContext();
    const root = join(directoryContext.home, ".claude");
    const target = await mkdtemp(join(tmpdir(), "agentrinse-claude-cache-target-"));
    await mkdir(root);
    await writeFile(join(target, "changelog.md"), "outside");
    await symlink(target, join(root, "cache"));
    const claude = adapter();

    const directoryProbe = await claude.probe(directoryContext);
    const directoryCollection = await claude.collect(directoryContext, directoryProbe);

    expect(
      directoryCollection.resources.some(
        (resource) => resource.facts.policyId === CLAUDE_CHANGELOG_CACHE_POLICY_ID,
      ),
    ).toBe(false);

    const fileContext = await fixtureContext();
    const cache = join(fileContext.home, ".claude", "cache");
    const outside = join(fileContext.home, "outside.md");
    await mkdir(cache, { recursive: true });
    await writeFile(outside, "outside");
    await symlink(outside, join(cache, "changelog.md"));

    const fileProbe = await claude.probe(fileContext);
    const fileCollection = await claude.collect(fileContext, fileProbe);

    expect(
      fileCollection.resources.some(
        (resource) => resource.facts.policyId === CLAUDE_CHANGELOG_CACHE_POLICY_ID,
      ),
    ).toBe(false);
  });

  it("matches only the exact Claude changelog cache path", () => {
    expect(isClaudeChangelogCacheRelativePath(`cache${sep}changelog.md`)).toBe(true);
    expect(isClaudeChangelogCacheRelativePath("cache/my-closed-issues.json")).toBe(false);
    expect(isClaudeChangelogCacheRelativePath("cache/nested/changelog.md")).toBe(false);
    expect(isClaudeChangelogCacheRelativePath("changelog.md")).toBe(false);
    if (sep === "/") {
      expect(isClaudeChangelogCacheRelativePath("cache\\changelog.md")).toBe(false);
    }
  });
});
