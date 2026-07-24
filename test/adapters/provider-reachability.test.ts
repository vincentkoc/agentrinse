import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuditAdapter } from "../../src/adapters/provider-adapter.js";
import { PROVIDER_SPECS } from "../../src/adapters/provider-specs.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import { ReachabilityIndex } from "../../src/core/reachability.js";

async function fixtureContext(): Promise<AuditContext> {
  return {
    home: await mkdtemp(join(tmpdir(), "agentrinse-reachability-")),
    now: new Date("2026-07-24T00:00:00.000Z"),
    auditId: "audit-reachability",
  };
}

describe("provider reachability metadata", () => {
  it("links Codex workspaces without reading transcript files", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".codex");
    const active = join(context.home, "src", "active");
    const recent = join(context.home, "src", "recent");
    const managed = join(root, "worktrees", "repo", "task");
    await mkdir(join(root, "sessions"), { recursive: true });
    await mkdir(managed, { recursive: true });
    await writeFile(join(root, "sessions", "secret.jsonl"), "never emit this transcript");
    await writeFile(
      join(root, ".codex-global-state.json"),
      JSON.stringify({
        "active-workspace-roots": [active],
        "electron-saved-workspace-roots": [],
        "thread-workspace-root-hints": { "private-thread-id": recent },
      }),
    );
    const reachability = new ReachabilityIndex();
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      root,
      measureBytes: false,
      maxEntries: 100,
      reachability,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const roots = [
      ...reachability.rootsFor(active, context.now.toISOString()),
      ...reachability.rootsFor(recent, context.now.toISOString()),
      ...reachability.rootsFor(managed, context.now.toISOString()),
    ];

    expect(collection.diagnostics).toEqual([]);
    expect(roots.map((root) => root.code)).toEqual([
      "active-session",
      "recent-session",
      "provider-managed-worktree",
    ]);
    expect(JSON.stringify(roots)).not.toContain("private-thread-id");
    expect(JSON.stringify(roots)).not.toContain("never emit this transcript");
  });

  it("links Claude project keys without reading session bodies", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const project = join(context.home, "src", "project");
    await mkdir(join(root, "projects", "encoded-project"), { recursive: true });
    await writeFile(
      join(root, "projects", "encoded-project", "secret.jsonl"),
      "never emit this transcript",
    );
    await writeFile(
      join(context.home, ".claude.json"),
      JSON.stringify({
        projects: {
          [project]: {
            lastSessionId: "private-session-id",
          },
        },
      }),
    );
    const reachability = new ReachabilityIndex();
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
      root,
      measureBytes: false,
      maxEntries: 100,
      reachability,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const roots = reachability.rootsFor(project, context.now.toISOString());

    expect(collection.diagnostics).toEqual([]);
    expect(roots.map((root) => root.code)).toEqual(["recent-session"]);
    expect(JSON.stringify(roots)).not.toContain("private-session-id");
    expect(JSON.stringify(roots)).not.toContain("never emit this transcript");
  });

  it("fails closed when supported provider metadata is malformed", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".codex");
    await mkdir(root);
    await writeFile(join(root, ".codex-global-state.json"), "{broken");
    const reachability = new ReachabilityIndex();
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.codex, {
      root,
      measureBytes: false,
      maxEntries: 100,
      reachability,
    });

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const roots = reachability.rootsFor(
      join(context.home, "any-worktree"),
      context.now.toISOString(),
    );

    expect(collection.diagnostics.map((item) => item.code)).toContain(
      "CODEX_WORKSPACE_METADATA_INVALID",
    );
    expect(roots.map((root) => root.code)).toContain("unknown-provider-state");
  });

  it("fails closed when a provider root cannot be inspected", async () => {
    const context = await fixtureContext();
    const root = join(context.home, ".claude");
    const target = await mkdtemp(join(tmpdir(), "agentrinse-claude-target-"));
    await symlink(target, root);
    const reachability = new ReachabilityIndex();
    const adapter = new ProviderAuditAdapter(PROVIDER_SPECS.claude, {
      root,
      measureBytes: false,
      maxEntries: 100,
      reachability,
    });

    const probe = await adapter.probe(context);
    await adapter.collect(context, probe);

    expect(probe.status).toBe("degraded");
    expect(
      reachability
        .rootsFor(join(context.home, "any-worktree"), context.now.toISOString())
        .map((root) => root.code),
    ).toContain("unknown-provider-state");
  });
});
