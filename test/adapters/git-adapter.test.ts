import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import { ReachabilityIndex } from "../../src/core/reachability.js";

const execFileAsync = promisify(execFile);

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
      if (command === "ls-files") {
        return "";
      }
      if (command === "for-each-ref") {
        if (args.includes("--points-at")) {
          return worktree === linked ? "refs/tags/v0.2.0\n" : "";
        }
        return worktree === linked
          ? "refs/heads/task\n"
          : "refs/heads/main\nrefs/remotes/origin/main\n";
      }
      if (command === "rev-parse" && args.includes("--git-path")) {
        return `.git/${args.at(-1)!}`;
      }
      if (command === "rev-parse" && args.includes("--git-common-dir")) {
        return `${join(main, ".git")}\n`;
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
      evidenceRef: "pin:branch",
    });
    reachability.addGitRef("refs/tags/v0.2.0", {
      code: "user-pin",
      source: "config",
      detail: "User configuration pins this resource.",
      evidenceRef: "pin:tag",
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
    expect(
      reachability
        .rootsFor(join(linked, "node_modules"), context.now.toISOString())
        .filter((root) => root.code === "user-pin"),
    ).toHaveLength(2);
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
      if (command === "ls-files") {
        return "";
      }
      if (command === "rev-parse" && args.includes("--git-path")) {
        return `.git/${args.at(-1)!}`;
      }
      if (command === "rev-parse" && args.includes("--git-common-dir")) {
        return `${join(main, ".git")}\n`;
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

  it("offers quarantine only for a fully proven inactive linked worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-"));
    const main = join(home, "repo");
    const linked = join(home, "task");
    await mkdir(main);
    await mkdir(linked);
    const context: AuditContext = {
      home,
      now: new Date("2026-07-24T00:00:00.000Z"),
      auditId: "audit-eligible",
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
        const branch = worktree === main ? "main" : "task";
        const head =
          worktree === main
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        return [
          `# branch.oid ${head}`,
          `# branch.head ${branch}`,
          `# branch.upstream origin/${branch}`,
          "# branch.ab +0 -0",
          "",
        ].join("\0");
      }
      if (command === "remote") {
        return "origin\n";
      }
      if (command === "ls-files") {
        return "";
      }
      if (command === "for-each-ref") {
        if (args.includes("--points-at")) {
          return "";
        }
        const branch = worktree === main ? "main" : "task";
        return `refs/heads/${branch}\nrefs/remotes/origin/${branch}\n`;
      }
      if (command === "rev-parse" && args.includes("--git-path")) {
        return `.git/${args.at(-1)!}`;
      }
      if (command === "rev-parse" && args.includes("--git-common-dir")) {
        return `${join(main, ".git")}\n`;
      }
      throw new Error(`unexpected Git command: ${args.join(" ")}`);
    };
    const adapter = new GitWorktreeAuditAdapter(
      main,
      runner,
      async () => false,
      async () => ({ status: "idle", matches: [] }),
      undefined,
      {
        maxEntries: 100,
        measureBytes: true,
        minAgeMinutes: 14 * 24 * 60,
        quarantineTtlMinutes: 7 * 24 * 60,
        platform: "darwin",
      },
      {
        measure: async () => ({
          bytes: 4096,
          entries: 3,
          symlinksSkipped: 0,
          specialEntries: 0,
          truncated: false,
          newestMtimeMs: Date.parse("2026-07-01T00:00:00.000Z"),
          fingerprint: "c".repeat(64),
          mountBoundaries: 0,
        }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    );

    const collection = await adapter.collect(context, await adapter.probe(context));
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );
    expect(findings[0]?.state).toBe("protected");
    expect(findings[1]?.state).toBe("eligible");
    expect(findings[1]?.candidateActions).toEqual([
      expect.objectContaining({
        type: "worktree.quarantine",
        risk: "recoverable",
        expectedReclaimBytes: 0,
        pendingQuarantineBytes: 4096,
        quarantineTtlMinutes: 7 * 24 * 60,
        target: expect.objectContaining({
          path: linked,
          repositoryCommonDir: join(main, ".git"),
          branch: "refs/heads/task",
          head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          measuredBytes: 4096,
          fingerprint: "c".repeat(64),
        }),
      }),
    ]);
  });

  it("discovers an eligible linked worktree from real Git porcelain", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-real-"));
    const main = join(home, "repo");
    const linked = join(home, "task");
    const remote = join(home, "remote.git");
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["init", "-b", "main", main]);
    await execFileAsync("git", ["-C", main, "config", "user.email", "fixture@example.test"]);
    await execFileAsync("git", ["-C", main, "config", "user.name", "AgentRinse Fixture"]);
    await writeFile(join(main, "README.md"), "fixture\n");
    await writeFile(join(main, ".gitignore"), ".env\n");
    await execFileAsync("git", ["-C", main, "add", "README.md", ".gitignore"]);
    await execFileAsync("git", ["-C", main, "commit", "-m", "fixture"]);
    await execFileAsync("git", ["-C", main, "remote", "add", "origin", remote]);
    await execFileAsync("git", ["-C", main, "push", "-u", "origin", "main"]);
    await execFileAsync("git", ["-C", main, "branch", "task"]);
    await execFileAsync("git", ["-C", main, "push", "-u", "origin", "task"]);
    await execFileAsync("git", ["-C", main, "worktree", "add", linked, "task"]);
    const runGit = async (args: string[]) =>
      (
        await execFileAsync("git", args, {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    const adapter = new GitWorktreeAuditAdapter(
      main,
      runGit,
      undefined,
      async () => ({ status: "idle", matches: [] }),
      undefined,
      {
        maxEntries: 10_000,
        measureBytes: true,
        minAgeMinutes: 0,
        quarantineTtlMinutes: 60,
        platform: process.platform === "linux" ? "linux" : "darwin",
      },
      {
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    );
    const context: AuditContext = {
      home,
      now: new Date(),
      auditId: "audit-real-git",
    };

    const collection = await adapter.collect(context, await adapter.probe(context));
    const physicalMain = await realpath(main);
    const physicalLinked = await realpath(linked);
    const linkedResource = collection.resources.find((resource) => resource.facts.isMain === false);
    expect(linkedResource).toBeDefined();

    const finding = await adapter.classify(context, linkedResource!);

    expect(collection.diagnostics).toEqual([]);
    expect(finding.state).toBe("eligible");
    expect(finding.candidateActions[0]).toMatchObject({
      type: "worktree.quarantine",
      expectedReclaimBytes: 0,
      target: {
        path: physicalLinked,
        repositoryCommonDir: join(physicalMain, ".git"),
        branch: "refs/heads/task",
      },
    });
    const reservedFinding = await adapter.classify(context, {
      ...linkedResource!,
      resource: {
        ...linkedResource!.resource,
        path: join(home, ".agentrinse-quarantine"),
      },
    });
    expect(reservedFinding).toMatchObject({
      state: "protected",
      roots: expect.arrayContaining([
        expect.objectContaining({ code: "worktree-quarantine-path-reserved" }),
      ]),
      candidateActions: [],
    });

    await writeFile(join(linked, ".env"), "local-only\n");
    const ignoredCollection = await adapter.collect(context, await adapter.probe(context));
    const ignoredResource = ignoredCollection.resources.find(
      (resource) => resource.facts.isMain === false,
    );
    const ignoredFinding = await adapter.classify(context, ignoredResource!);
    expect(ignoredFinding).toMatchObject({
      state: "protected",
      roots: expect.arrayContaining([expect.objectContaining({ code: "dirty-worktree" })]),
    });

    await rm(join(linked, ".env"));
    await execFileAsync("git", ["-C", linked, "update-index", "--assume-unchanged", "README.md"]);
    const suppressedCollection = await adapter.collect(context, await adapter.probe(context));
    const suppressedResource = suppressedCollection.resources.find(
      (resource) => resource.facts.isMain === false,
    );
    const suppressedFinding = await adapter.classify(context, suppressedResource!);
    expect(suppressedFinding).toMatchObject({
      state: "protected",
      roots: expect.arrayContaining([expect.objectContaining({ code: "git-status-suppressed" })]),
    });

    const failingMeasurementAdapter = new GitWorktreeAuditAdapter(
      main,
      runGit,
      undefined,
      async () => ({ status: "idle", matches: [] }),
      undefined,
      {
        maxEntries: 10_000,
        measureBytes: true,
        minAgeMinutes: 0,
        quarantineTtlMinutes: 60,
        platform: process.platform === "linux" ? "linux" : "darwin",
      },
      {
        measure: async () => {
          throw new Error("injected measurement failure");
        },
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    );
    const failedCollection = await failingMeasurementAdapter.collect(
      context,
      await failingMeasurementAdapter.probe(context),
    );
    const failedResource = failedCollection.resources.find(
      (resource) => resource.facts.isMain === false,
    );
    const failedFinding = await failingMeasurementAdapter.classify(context, failedResource!);
    expect(failedResource?.facts.inspectionComplete).toBe(false);
    expect(failedCollection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "GIT_WORKTREE_INSPECTION_FAILED",
          message: "injected measurement failure",
        }),
      ]),
    );
    expect(failedFinding).toMatchObject({
      state: "unknown",
      roots: expect.arrayContaining([
        expect.objectContaining({ code: "git-inspection-incomplete" }),
      ]),
      candidateActions: [],
    });
  });
});
