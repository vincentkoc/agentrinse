import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import { ReachabilityIndex } from "../../src/core/reachability.js";

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
      const worktree = args[1];
      const command = args[2];
      if (command === "worktree") {
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
      }
      if (command === "status") {
        return worktree === linked
          ? [
              "# branch.oid bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "# branch.head task",
              "# branch.upstream origin/task",
              "# branch.ab +1 -0",
              "1 M. N... 100644 100644 100644 a a staged.ts",
              "",
            ].join("\0")
          : [
              "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "# branch.head main",
              "# branch.upstream origin/main",
              "# branch.ab +0 -0",
              "",
            ].join("\0");
      }
      if (command === "remote") {
        return "origin\n";
      }
      if (command === "for-each-ref") {
        return worktree === linked
          ? "refs/heads/task\n"
          : "refs/heads/main\nrefs/remotes/origin/main\n";
      }
      if (command === "rev-parse" && args.includes("--git-path")) {
        return `.git/${args.at(-1)!}`;
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    };
    const reachability = new ReachabilityIndex();
    reachability.add({
      path: linked,
      code: "recent-session",
      source: "codex",
      detail: "Codex metadata references this workspace.",
    });
    reachability.addGitRef("refs/heads/task", {
      code: "user-pin",
      source: "config",
      detail: "User configuration pins this resource.",
    });
    const adapter = new GitWorktreeAuditAdapter(
      main,
      runner,
      async (path) => path === join(linked, ".git", "MERGE_HEAD"),
      async (path) =>
        path === linked
          ? { status: "busy", matches: [{ pid: 42, source: "cwd", path: linked }] }
          : { status: "idle", matches: [] },
      reachability,
    );

    const probe = await adapter.probe(context);
    const collection = await adapter.collect(context, probe);
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );

    expect(collection.resources).toHaveLength(2);
    expect(findings.map((finding) => finding.state)).toEqual(["protected", "protected"]);
    expect(findings[0]?.roots.map((root) => root.code)).toContain("main-worktree");
    expect(findings[1]?.roots.map((root) => root.code)).toEqual(
      expect.arrayContaining([
        "dirty-worktree",
        "git-operation-in-progress",
        "live-process-worktree",
        "recent-session",
        "unpushed-commit",
        "user-pin",
      ]),
    );
    expect(collection.resources[1]?.facts).toMatchObject({
      staged: 1,
      dirty: true,
      ahead: 1,
      localReachable: true,
      remoteReachable: false,
      unpushed: true,
      operations: ["merge"],
      processOwnership: "busy",
      processMatches: [{ pid: 42, source: "cwd" }],
      inspectionComplete: true,
    });
  });

  it("keeps the primary worktree identity when auditing from a linked worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-"));
    const main = join(home, "repo");
    const linked = join(home, "task");
    await mkdir(main);
    await mkdir(linked);
    const context: AuditContext = {
      home,
      now: new Date("2026-07-23T00:00:00.000Z"),
      auditId: "audit-linked-root",
    };
    const runner = async (args: string[]) => {
      if (args.includes("--show-toplevel")) {
        return `${linked}\n`;
      }
      const worktree = args[1];
      const command = args[2];
      if (command === "worktree") {
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
      }
      if (command === "status") {
        const branch = worktree === main ? "main" : "task";
        const head =
          worktree === main
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        return [`# branch.oid ${head}`, `# branch.head ${branch}`, ""].join("\0");
      }
      if (command === "remote" || command === "for-each-ref") {
        return "";
      }
      if (command === "rev-parse" && args.includes("--git-path")) {
        return `.git/${args.at(-1)!}`;
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    };
    const adapter = new GitWorktreeAuditAdapter(
      linked,
      runner,
      async () => false,
      async () => ({ status: "idle", matches: [] }),
    );

    const collection = await adapter.collect(context, await adapter.probe(context));

    expect(collection.resources.map((resource) => resource.resource.displayName)).toEqual([
      "Main worktree",
      "Linked worktree",
    ]);
    expect(collection.resources.map((resource) => resource.facts.isMain)).toEqual([true, false]);
  });
});
