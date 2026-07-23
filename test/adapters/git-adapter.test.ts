import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

describe("GitWorktreeAuditAdapter", () => {
  it("requires an explicit repository root", async () => {
    const context: AuditContext = {
      home: await mkdtemp(join(tmpdir(), "agentrinse-git-")),
      now: new Date("2026-07-23T00:00:00.000Z"),
      auditId: "audit-git",
    };
    const adapter = new GitWorktreeAuditAdapter(undefined);

    expect((await adapter.probe(context)).status).toBe("degraded");
  });

  it("inventories worktrees as protected using a fake Git runner", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-"));
    const main = join(home, "repo");
    const linked = join(home, "task");
    await mkdir(main);
    await mkdir(linked);
    const context: AuditContext = {
      home,
      now: new Date("2026-07-23T00:00:00.000Z"),
      auditId: "audit-git",
    };
    const runner = async (args: string[]) => {
      if (args.includes("--show-toplevel")) {
        return `${main}\n`;
      }
      return [
        `worktree ${main}`,
        "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "branch refs/heads/main",
        "",
        `worktree ${linked}`,
        "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "branch refs/heads/task",
        "",
      ].join("\0");
    };
    const adapter = new GitWorktreeAuditAdapter(main, runner);

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const findings = await Promise.all(
      collection.resources.map((resource) =>
        adapter.classify(context, resource),
      ),
    );

    expect(collection.resources).toHaveLength(2);
    expect(findings.map((finding) => finding.state)).toEqual([
      "protected",
      "protected",
    ]);
    expect(findings[0]?.roots.map((root) => root.code)).toContain(
      "main-worktree",
    );
  });
});
