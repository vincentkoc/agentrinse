import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import * as registry from "../../src/adapters/registry.js";
import { executeCleanCommand } from "../../src/commands/clean.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";
import { gitFixture } from "../core/worktree-fixture.js";

it.each(["timeout", "exit", "overflow"])(
  "retains fleet siblings after a worktree status %s",
  async (failure) => {
    const fixture = await gitFixture();
    const sibling = join(fixture.home, "zz-sibling");
    await fixture.runGit(["-C", fixture.main, "worktree", "add", "-b", "sibling", sibling]);
    const config = structuredClone(DEFAULT_CONFIG);
    for (const adapter of Object.values(config.adapters)) adapter.enabled = false;
    config.worktrees.minAgeMinutes = 0;
    const configPath = join(fixture.home, "config.json");
    await writeJsonAtomic(configPath, config);
    let injected = 0;
    const inspected: string[] = [];
    const createAdapters = registry.createAuditAdapters;
    const spy = vi
      .spyOn(registry, "createAuditAdapters")
      .mockImplementation((current, platform, options) => {
        expect(options?.gitRepositories).toHaveLength(1);
        return createAdapters(current, platform, options).map((adapter) =>
          adapter.id !== "git"
            ? adapter
            : new GitWorktreeAuditAdapter(
                fixture.main,
                async (args) => {
                  if (args[2] === "status") {
                    inspected.push(args[1]!);
                    if (args[1] === fixture.linked) {
                      injected++;
                      if (failure === "timeout")
                        await new Promise((resolve) => setTimeout(resolve, 5));
                      throw Object.assign(
                        new Error(
                          failure === "timeout"
                            ? "injected status timeout"
                            : failure === "exit"
                              ? "injected status exit 128"
                              : "injected stdout overflow",
                        ),
                        {
                          code: failure === "overflow" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : 128,
                        },
                      );
                    }
                  }
                  return fixture.runGit(args);
                },
                undefined,
                async () => ({ status: "idle", matches: [] }),
                undefined,
                { ...current.audit, ...current.worktrees, platform: "linux" },
                {
                  isolateRepositoryFailure: true,
                  discovery: options!.gitRepositories![0]!.discovery!,
                  mountProbe: async () => ({ status: "clear", paths: [] }),
                },
              ),
        );
      });
    try {
      const result = await executeCleanCommand({
        home: fixture.home,
        config: configPath,
        stateDir: join(fixture.home, "state"),
        profile: "fleet",
        repos: [fixture.main],
        maxRisk: "recoverable",
        apply: false,
        yes: false,
        json: false,
      });
      expect(injected).toBe(1);
      expect(inspected).toEqual(expect.arrayContaining([fixture.main, fixture.linked, sibling]));
      expect(result.summary.worktrees).toBe(3);
      expect(result.status).toBe("degraded");
      expect(result.audit.diagnostics).toEqual([
        expect.objectContaining({ code: "GIT_WORKTREE_INSPECTION_FAILED" }),
      ]);
      const failed = result.audit.findings.find(
        (finding) => finding.resource.path === fixture.linked,
      )!;
      expect(failed).toMatchObject({
        state: "unknown",
        confidence: "unknown",
        candidateActions: [],
        facts: { inspectionComplete: false },
        roots: expect.arrayContaining([
          expect.objectContaining({ code: "git-inspection-incomplete" }),
        ]),
      });
      expect(
        result.audit.findings.find((finding) => finding.resource.path === fixture.main)?.facts
          .inspectionComplete,
      ).toBe(true);
      expect(
        result.audit.findings.find((finding) => finding.resource.path === sibling),
      ).toMatchObject({
        state: "eligible",
        facts: { inspectionComplete: true },
      });
      expect(
        result.plan.actions.map((action) =>
          "path" in action.target ? action.target.path : undefined,
        ),
      ).toEqual([sibling]);
      expect(JSON.parse(await readFile(result.summary.auditPath, "utf8"))).toEqual(result.audit);
      expect(JSON.parse(await readFile(result.summary.planPath, "utf8"))).toEqual(result.plan);
      for (const path of [fixture.main, fixture.linked, sibling]) {
        expect(await readFile(join(path, "README.md"), "utf8")).toBe("fixture\n");
      }
    } finally {
      spy.mockRestore();
    }
  },
  30_000,
);

it.each(["common-dir", "worktree-list"])(
  "keeps %s discovery failure repository-wide",
  async (failure) => {
    const fixture = await gitFixture();
    const config = structuredClone(DEFAULT_CONFIG);
    for (const adapter of Object.values(config.adapters)) adapter.enabled = false;
    const configPath = join(fixture.home, "config.json");
    await writeJsonAtomic(configPath, config);
    let injected = 0;
    const result = await executeCleanCommand({
      home: fixture.home,
      config: configPath,
      stateDir: join(fixture.home, "state"),
      profile: "fleet",
      repos: [fixture.main],
      maxRisk: "recoverable",
      apply: false,
      yes: false,
      json: false,
      dependencies: {
        runCommand: async (_command, args) => {
          if (
            failure === "common-dir" ? args.includes("--git-common-dir") : args.includes("list")
          ) {
            injected++;
            throw new Error("injected discovery failure");
          }
          return { stdout: await fixture.runGit(args), stderr: "" };
        },
      },
    });
    expect(injected).toBe(1);
    expect(result.status).toBe("degraded");
    expect(result.summary.worktrees).toBe(0);
    expect(result.plan.actions).toEqual([]);
    expect(result.audit.diagnostics).toContainEqual(
      expect.objectContaining({
        code: failure === "common-dir" ? "GIT_PROBE_FAILED" : "GIT_REPOSITORY_INSPECTION_FAILED",
      }),
    );
  },
  30_000,
);
