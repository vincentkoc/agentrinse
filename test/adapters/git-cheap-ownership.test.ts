import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import {
  cheapWorktreeProtections,
  shouldDeferProcessOwnership,
} from "../../src/adapters/git/cheap-protection.js";
import type { GitWorktreeRecord } from "../../src/adapters/git/porcelain.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

describe("cheapWorktreeProtections", () => {
  it("detects main, dirty, and young worktrees before ownership", () => {
    expect(
      cheapWorktreeProtections({
        isMain: true,
        platform: "linux",
        bare: false,
        locked: undefined,
        prunable: undefined,
        dirty: false,
        ageMinutes: 10_000,
        minAgeMinutes: 100,
      }).map((item) => item.code),
    ).toContain("main-worktree");

    expect(
      shouldDeferProcessOwnership({
        isMain: false,
        platform: "linux",
        bare: false,
        locked: undefined,
        prunable: undefined,
        dirty: true,
        ageMinutes: 10_000,
        minAgeMinutes: 100,
      }),
    ).toBe(true);

    expect(
      shouldDeferProcessOwnership({
        isMain: false,
        platform: "linux",
        bare: false,
        locked: undefined,
        prunable: undefined,
        dirty: false,
        ageMinutes: 10,
        minAgeMinutes: 100,
      }),
    ).toBe(true);
  });
});

describe("GitWorktreeAuditAdapter ownership deferral", () => {
  it("skips process ownership for 100+ worktrees already excluded by cheap gates", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-budget-"));
    const main = join(home, "main");
    const context: AuditContext = {
      home,
      now: new Date("2026-10-27T00:00:00.000Z"),
      auditId: "audit-cheap-fleet",
    };

    const records: GitWorktreeRecord[] = Array.from({ length: 120 }, (_, index) => ({
      path: index === 0 ? main : join(home, `wt-${index}`),
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: index === 0 ? "refs/heads/main" : `refs/heads/task-${index}`,
      detached: false,
      bare: false,
    }));
    await Promise.all(records.map((record) => mkdir(record.path, { recursive: true })));

    const probedPaths: string[] = [];
    const runner = async (args: string[]) => {
      if (args.includes("--show-toplevel")) {
        return `${main}\n`;
      }
      const command = args[2];
      if (command === "status") {
        if (args[1] === main) {
          return [
            "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "# branch.head main",
            "",
          ].join("\0");
        }
        return [
          "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "# branch.head task",
          "1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa README.md",
          "",
        ].join("\0");
      }
      if (command === "remote") {
        return "origin\n";
      }
      if (command === "rev-parse") {
        if (args.includes("--git-path")) {
          const marker = args[args.length - 1] ?? "HEAD";
          return `${args[1]}/.git/${marker}\n`;
        }
        return `${main}/.git\n`;
      }
      if (command === "ls-files" || command === "for-each-ref" || command === "rev-list") {
        return "";
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    const adapter = new GitWorktreeAuditAdapter(
      main,
      runner,
      async () => true,
      async (path) => {
        probedPaths.push(path);
        return { status: "idle", matches: [] };
      },
      undefined,
      {
        maxEntries: 100,
        measureBytes: true,
        minAgeMinutes: 14 * 24 * 60,
        quarantineTtlMinutes: 7 * 24 * 60,
        platform: "linux",
      },
      {
        discovery: { records },
        measure: async () => ({
          bytes: 10,
          entries: 1,
          symlinksSkipped: 0,
          specialEntries: 0,
          vcsMetadataEntries: 0,
          truncated: false,
          newestMtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          fingerprint: "b".repeat(64),
          mountBoundaries: 0,
        }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    );

    const started = performance.now();
    const collection = await adapter.collect(context, await adapter.probe(context));
    const elapsedMs = performance.now() - started;
    const findings = await Promise.all(
      collection.resources.map((resource) => adapter.classify(context, resource)),
    );

    expect(collection.resources).toHaveLength(120);
    expect(probedPaths).toEqual([]);
    expect(
      collection.resources.every((resource) => resource.facts.processOwnershipDeferred === true),
    ).toBe(true);
    expect(findings.every((finding) => finding.state === "protected")).toBe(true);
    expect(findings.every((finding) => finding.candidateActions.length === 0)).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 15_000);

  it("still probes ownership for a worktree that survives cheap gates", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-candidate-"));
    const main = join(home, "main");
    const linked = join(home, "old-clean");
    await mkdir(main, { recursive: true });
    await mkdir(linked, { recursive: true });
    const context: AuditContext = {
      home,
      now: new Date("2026-10-27T00:00:00.000Z"),
      auditId: "audit-candidate-ownership",
    };
    const probedPaths: string[] = [];
    const runner = async (args: string[]) => {
      if (args.includes("--show-toplevel")) {
        return `${main}\n`;
      }
      const worktree = args[1];
      const command = args[2];
      if (command === "status") {
        const branch = worktree === main ? "main" : "old-clean";
        return [
          `# branch.oid ${"a".repeat(40)}`,
          `# branch.head ${branch}`,
          `# branch.upstream origin/${branch}`,
          "# branch.ab +0 -0",
          "",
        ].join("\0");
      }
      if (command === "remote") {
        return "origin\n";
      }
      if (command === "rev-parse") {
        if (args.includes("--git-path")) {
          const marker = args[args.length - 1] ?? "HEAD";
          return `${args[1]}/.git/${marker}\n`;
        }
        return `${main}/.git\n`;
      }
      if (command === "ls-files" || command === "for-each-ref" || command === "rev-list") {
        return "";
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    const adapter = new GitWorktreeAuditAdapter(
      main,
      runner,
      async () => true,
      async (path) => {
        probedPaths.push(path);
        return { status: "idle", matches: [] };
      },
      undefined,
      {
        maxEntries: 100,
        measureBytes: true,
        minAgeMinutes: 60,
        quarantineTtlMinutes: 7 * 24 * 60,
        platform: "linux",
      },
      {
        discovery: {
          records: [
            {
              path: main,
              head: "a".repeat(40),
              branch: "refs/heads/main",
              detached: false,
              bare: false,
            },
            {
              path: linked,
              head: "a".repeat(40),
              branch: "refs/heads/old-clean",
              detached: false,
              bare: false,
            },
          ],
        },
        measure: async () => ({
          bytes: 10,
          entries: 1,
          symlinksSkipped: 0,
          specialEntries: 0,
          vcsMetadataEntries: 0,
          truncated: false,
          newestMtimeMs: Date.parse("2026-01-01T00:00:00.000Z"),
          fingerprint: "c".repeat(64),
          mountBoundaries: 0,
        }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    );

    const collection = await adapter.collect(context, await adapter.probe(context));
    expect(probedPaths).toEqual([linked]);
    const linkedResource = collection.resources.find(
      (resource) => resource.resource.path === linked,
    );
    expect(linkedResource?.facts.processOwnershipDeferred).toBe(false);
    expect(linkedResource?.facts.processOwnership).toBe("idle");
  });
});
