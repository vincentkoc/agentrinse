import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import {
  inspectClaudeNativeRetention,
  type ClaudeRetentionDependencies,
} from "../../src/adapters/claude-retention.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-claude-retention-")),
    now: new Date("2026-07-27T00:00:00.000Z"),
    auditId: "audit-claude-retention",
  };
}

function adapter(): ProviderAuditAdapter {
  return new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
    environment: {},
    measureBytes: true,
    maxEntries: 100,
  });
}

describe("Claude native retention reporting", () => {
  it("reports the documented default for native-cleaned resources without mutating them", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    for (const relativePath of ["projects", "debug", "worktrees", "paste-cache", "image-cache"]) {
      await mkdir(join(root, relativePath), { recursive: true });
    }
    const claude = adapter();

    const probe = await claude.probe(context);
    const collection = await claude.collect(context, probe);
    const nativeResources = collection.resources.filter(
      (resource) => resource.facts.nativeRetention !== undefined,
    );
    const sessions = nativeResources.find(
      (resource) => resource.resource.displayName === "Claude project sessions",
    );
    const finding = await claude.classify(context, sessions!);

    expect(nativeResources).toHaveLength(4);
    expect(
      nativeResources.filter((resource) => resource.resource.kind === "agent-cache"),
    ).toHaveLength(2);
    expect(
      nativeResources.some(
        (resource) => resource.resource.displayName === "Claude managed worktrees",
      ),
    ).toBe(false);
    expect(sessions?.facts.nativeRetention).toEqual({
      mechanism: "cleanupPeriodDays",
      documentedDefaultDays: 30,
      startupSweep: true,
      effectiveDaysKnown: false,
      userSettingsStatus: "missing",
    });
    expect(finding).toMatchObject({
      state: "protected",
      confidence: "high",
      roots: [{ code: "claude-native-retention-expected" }, { code: "provider-owned-report-only" }],
      candidateActions: [],
    });
  });

  it("reports a valid user cleanup period without claiming it is globally effective", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    await mkdir(join(root, "projects"), { recursive: true });
    await writeFile(join(root, "settings.json"), '{"cleanupPeriodDays":45}\n');
    const claude = adapter();

    const probe = await claude.probe(context);
    const collection = await claude.collect(context, probe);
    const sessions = collection.resources.find(
      (resource) => resource.resource.displayName === "Claude project sessions",
    );
    const finding = await claude.classify(context, sessions!);

    expect(sessions?.facts.nativeRetention).toMatchObject({
      userSettingsStatus: "valid",
      userConfiguredDays: 45,
      effectiveDaysKnown: false,
    });
    expect(finding.roots[0]).toMatchObject({
      code: "claude-native-retention-expected",
      detail:
        "Claude user settings declare a 45-day startup retention sweep; higher-precedence settings were not resolved.",
    });
    expect(finding.candidateActions).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{", "Claude user settings are not valid JSON"],
    ["zero days", '{"cleanupPeriodDays":0}', "must be an integer of at least 1"],
    ["fractional days", '{"cleanupPeriodDays":1.5}', "must be an integer of at least 1"],
  ])("reports uncertain native cleanup for %s", async (_name, contents, message) => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    await mkdir(join(root, "projects"), { recursive: true });
    await writeFile(join(root, "settings.json"), contents);
    const claude = adapter();

    const probe = await claude.probe(context);
    const collection = await claude.collect(context, probe);
    const sessions = collection.resources.find(
      (resource) => resource.resource.displayName === "Claude project sessions",
    );
    const finding = await claude.classify(context, sessions!);

    expect(collection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CLAUDE_RETENTION_SETTINGS_INVALID",
        message: expect.stringContaining(message),
      }),
    );
    expect(sessions?.facts.nativeRetention).toMatchObject({
      userSettingsStatus: "invalid",
      effectiveDaysKnown: false,
    });
    expect(finding).toMatchObject({
      state: "protected",
      confidence: "unknown",
      candidateActions: [],
    });
    expect(finding.roots.map((root) => root.code)).toEqual([
      "claude-native-retention-uncertain",
      "provider-owned-report-only",
    ]);
  });

  it("does not follow a symlinked Claude settings file", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const outside = join(context.home, "outside-settings.json");
    await mkdir(root);
    await writeFile(outside, '{"cleanupPeriodDays":1}\n');
    await symlink(outside, join(root, "settings.json"));

    const result = await inspectClaudeNativeRetention(root);

    expect(result.facts).toMatchObject({
      userSettingsStatus: "unsupported",
      effectiveDaysKnown: false,
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CLAUDE_RETENTION_SETTINGS_UNSUPPORTED" }),
    );
  });

  it("rejects settings that change while being read", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const settingsPath = join(root, "settings.json");
    const changedPath = join(root, "changed-settings.json");
    await mkdir(root);
    await writeFile(settingsPath, '{"cleanupPeriodDays":45}\n');
    await writeFile(changedPath, '{"cleanupPeriodDays":120,"changed":true}\n');
    const before = await lstat(settingsPath);
    const after = await lstat(changedPath);
    const stat = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const payload = Buffer.from('{"cleanupPeriodDays":45}\n');
    const read = vi.fn(
      async (buffer: Buffer, offset: number, _length: number, position: number) => {
        if (position > 0) {
          return { bytesRead: 0, buffer };
        }
        payload.copy(buffer, offset);
        return { bytesRead: payload.length, buffer };
      },
    );
    const dependencies = {
      lstat: async () => before,
      open: async () => ({
        stat,
        read,
        close: async () => undefined,
      }),
    } as unknown as ClaudeRetentionDependencies;

    const result = await inspectClaudeNativeRetention(root, "darwin", dependencies);

    expect(result.facts.userSettingsStatus).toBe("changed");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CLAUDE_RETENTION_SETTINGS_CHANGED" }),
    );
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it("bounds a growing settings read to one byte beyond the inspection limit", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const settingsPath = join(root, "settings.json");
    await mkdir(root);
    await writeFile(settingsPath, "{}\n");
    const stats = await lstat(settingsPath);
    const read = vi.fn(
      async (buffer: Buffer, _offset: number, length: number, _position: number) => ({
        bytesRead: length,
        buffer,
      }),
    );
    const dependencies = {
      lstat: async () => stats,
      open: async () => ({
        stat: async () => stats,
        read,
        close: async () => undefined,
      }),
    } as unknown as ClaudeRetentionDependencies;

    const result = await inspectClaudeNativeRetention(root, "darwin", dependencies);

    expect(result.facts.userSettingsStatus).toBe("too-large");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "CLAUDE_RETENTION_SETTINGS_TOO_LARGE" }),
    );
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[2]).toBe(1024 * 1024 + 1);
  });
});
