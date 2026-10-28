import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import { quarantineEntrySchema } from "../../src/contracts/quarantine.js";
import {
  executeWorktreeQuarantine,
  WorktreeExecutionError,
  worktreeQuarantinePath,
  worktreeRecoveryRef,
} from "../../src/core/worktree-executor.js";
import { undoWorktreeQuarantine } from "../../src/core/worktree-undo.js";
import { measurePath } from "../../src/core/measure.js";
import { renameNoReplace } from "../../src/core/no-clobber-rename.js";
import { readJsonFile } from "../../src/state/json-file.js";
import { gitFixture, missing, execFileAsync } from "./worktree-fixture.js";

describe("executeWorktreeQuarantine", () => {
  it("moves, repairs, locks, and journals a linked worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const runId = "run-fixture";
    const entryId = "entry-fixture";
    let protectionChecked = false;

    const result = await executeWorktreeQuarantine(fixture.action, {
      runId,
      entryId,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
        revalidateProtection: async () => {
          protectionChecked = true;
        },
        move: async (source, destination) => {
          expect(protectionChecked).toBe(true);
          await renameNoReplace(source, destination);
        },
      },
    });

    expect(await missing(fixture.linked)).toBe(true);
    expect(await missing(result.quarantinePath)).toBe(false);
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: result.quarantinePath,
          head: fixture.action.target.head,
          branch: fixture.action.target.branch,
          locked: `AgentRinse quarantine ${entryId}`,
        }),
      ]),
    );
    expect(
      (
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "rev-parse",
          "--verify",
          worktreeRecoveryRef(fixture.action, runId),
        ])
      ).trim(),
    ).toBe(fixture.action.target.head);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath))).toMatchObject({
      status: "quarantined",
      originalPath: fixture.linked,
      quarantinePath: result.quarantinePath,
    });
    expect(result.quarantinedBytes).toBe(fixture.action.target.measuredBytes);
  });

  it("refuses protection acquired at the atomic quarantine boundary", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-boundary-protected";
    const runId = "run-boundary-protected";

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          revalidateProtection: async () => {
            throw new Error("active-session");
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "WORKTREE_PROTECTION_CHANGED",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, entryId))).toBe(true);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("refuses quarantine when remote containment disappears during protection refresh", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-boundary-unpushed";
    const runId = "run-boundary-unpushed";
    let moveCalled = false;

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          revalidateProtection: async () => {
            const refs = (
              await fixture.runGit([
                "--git-dir",
                fixture.action.target.repositoryCommonDir,
                "for-each-ref",
                "--contains",
                fixture.action.target.head,
                "--format=%(refname)",
                "refs/remotes",
              ])
            )
              .trim()
              .split("\n")
              .filter((ref) => ref !== "");
            for (const ref of refs) {
              await fixture.runGit([
                "--git-dir",
                fixture.action.target.repositoryCommonDir,
                "update-ref",
                "-d",
                ref,
                fixture.action.target.head,
              ]);
            }
          },
          move: async () => {
            moveCalled = true;
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "WORKTREE_UNPUSHED",
    });

    expect(moveCalled).toBe(false);
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, entryId))).toBe(true);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("rejects a worktree that occupies the reserved quarantine container", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const action = {
      ...fixture.action,
      target: {
        ...fixture.action.target,
        path: join(dirname(fixture.linked), ".agentrinse-quarantine"),
      },
    };

    await expect(
      executeWorktreeQuarantine(action, {
        runId: "run-reserved-path",
        entryId: "entry-reserved-path",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "QUARANTINE_PATH_CONFLICT",
    });
  });

  it("rejects a quarantine container that is another registered worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const quarantineParent = join(fixture.home, ".agentrinse-quarantine");
    await fixture.runGit(["-C", fixture.main, "branch", "container"]);
    await fixture.runGit(["-C", fixture.main, "worktree", "add", quarantineParent, "container"]);

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-container-worktree",
        entryId: "entry-container-worktree",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "QUARANTINE_CONTAINER_WORKTREE",
    });

    expect(await missing(join(quarantineParent, "entry-container-worktree"))).toBe(true);
    expect(await missing(join(quarantineDirectory, "entry-container-worktree.json"))).toBe(true);
  });

  it("rejects a quarantine container registered by another repository", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const quarantineParent = join(fixture.home, ".agentrinse-quarantine");
    const otherRepository = join(fixture.home, "other-repo");
    await execFileAsync("git", ["init", "-b", "main", otherRepository]);
    await execFileAsync("git", [
      "-C",
      otherRepository,
      "config",
      "user.email",
      "fixture@example.test",
    ]);
    await execFileAsync("git", [
      "-C",
      otherRepository,
      "config",
      "user.name",
      "AgentRinse Fixture",
    ]);
    await writeFile(join(otherRepository, "README.md"), "other fixture\n");
    await execFileAsync("git", ["-C", otherRepository, "add", "README.md"]);
    await execFileAsync("git", ["-C", otherRepository, "commit", "-m", "other fixture"]);
    await execFileAsync("git", [
      "-C",
      otherRepository,
      "worktree",
      "add",
      "-b",
      "container",
      quarantineParent,
    ]);

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-foreign-container-worktree",
        entryId: "entry-foreign-container-worktree",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "QUARANTINE_CONTAINER_WORKTREE",
    });

    expect(await missing(join(quarantineParent, ".agentrinse-owner"))).toBe(true);
    expect(await missing(join(quarantineDirectory, "entry-foreign-container-worktree.json"))).toBe(
      true,
    );
  });

  it("does not adopt a symlinked quarantine container", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const quarantineParent = join(fixture.home, ".agentrinse-quarantine");
    const externalDirectory = join(fixture.home, "external-container");
    await mkdir(externalDirectory);
    await symlink(externalDirectory, quarantineParent);

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-symlinked-container",
        entryId: "entry-symlinked-container",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "QUARANTINE_CONTAINER_UNSAFE",
    });

    expect(await missing(join(externalDirectory, ".agentrinse-owner"))).toBe(true);
    expect(await missing(join(quarantineDirectory, "entry-symlinked-container.json"))).toBe(true);
  });

  it("rechecks the quarantine container immediately before moving the worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const quarantineParent = join(fixture.home, ".agentrinse-quarantine");
    const entryId = "entry-container-race";
    let recoveryRefCreated = false;
    let injectedMarker = false;
    const runGit = async (args: string[]) => {
      if (args.includes("update-ref") && !args.includes("-d")) {
        recoveryRefCreated = true;
      }
      if (
        recoveryRefCreated &&
        !injectedMarker &&
        args.includes("worktree") &&
        args.includes("list")
      ) {
        injectedMarker = true;
        await writeFile(join(quarantineParent, ".git"), "gitdir: /tmp/foreign-admin\n");
      }
      return fixture.runGit(args);
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-container-race",
        entryId,
        quarantineDirectory,
        dependencies: { runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "QUARANTINE_CONTAINER_WORKTREE",
    });

    expect(injectedMarker).toBe(true);
    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(join(quarantineParent, entryId))).toBe(true);
  });

  it("rejects a Git operation that starts after audit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const markerPath = (
      await fixture.runGit(["-C", fixture.linked, "rev-parse", "--git-path", "MERGE_HEAD"])
    ).trim();
    await writeFile(markerPath, `${fixture.action.target.head}\n`);

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-operation-race",
        entryId: "entry-operation-race",
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      diagnosticCode: "GIT_OPERATION_IN_PROGRESS",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, "entry-operation-race"))).toBe(
      true,
    );
  });

  it("does not repair a registration moved to a third path during quarantine", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-third-registration";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const thirdPath = join(fixture.home, "third-registration");

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-third-registration",
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          move: async (source, destination) => {
            await renameNoReplace(source, thirdPath);
            await fixture.runGit([
              "--git-dir",
              fixture.action.target.repositoryCommonDir,
              "worktree",
              "repair",
              thirdPath,
            ]);
            await renameNoReplace(thirdPath, destination);
          },
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "partially-applied",
    });

    expect(await missing(quarantinePath)).toBe(false);
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: thirdPath,
          head: fixture.action.target.head,
        }),
      ]),
    );
  });

  it("does not move the worktree when the Git lock claim fails", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-rollback";
    const runId = "run-rollback";
    const quarantinePath = worktreeQuarantinePath(fixture.action, entryId);
    const runGit = async (args: string[]) => {
      if (args.includes("lock")) {
        throw new Error("injected lock failure");
      }
      if (args.includes("update-ref") && args.includes("-d")) {
        const persisted = quarantineEntrySchema.parse(
          await readJsonFile(join(quarantineDirectory, `${entryId}.json`)),
        );
        expect(persisted.status).toBe("recovery-ref-created");
      }
      return fixture.runGit(args);
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: { runGit },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "failed",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(quarantinePath)).toBe(true);
    const manifest = quarantineEntrySchema.parse(
      await readJsonFile(join(quarantineDirectory, `${entryId}.json`)),
    );
    expect(manifest.status).toBe("restored");
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("preserves a foreign lock acquired at the quarantine boundary", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-boundary-foreign-lock";
    let moveCalled = false;
    let injected = false;
    const runGit = async (args: string[]) => {
      if (
        !injected &&
        args.includes("worktree") &&
        args.includes("lock") &&
        args.includes(`AgentRinse quarantine ${entryId}`)
      ) {
        injected = true;
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "worktree",
          "lock",
          "--reason",
          "operator hold",
          fixture.linked,
        ]);
      }
      return fixture.runGit(args);
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-boundary-foreign-lock",
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit,
          move: async () => {
            moveCalled = true;
          },
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "failed",
    });

    expect(injected).toBe(true);
    expect(moveCalled).toBe(false);
    expect(await missing(fixture.linked)).toBe(false);
    const records = parseWorktreePorcelain(
      await fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: fixture.linked,
          locked: "operator hold",
        }),
      ]),
    );
  });

  it("keeps rollback recoverable when recovery ref deletion fails", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-rollback-ref";
    const runId = "run-rollback-ref";
    const manifestPath = join(quarantineDirectory, `${entryId}.json`);
    let failRefDeletion = true;
    const runGit = async (args: string[]) => {
      if (args.includes("lock")) {
        throw new Error("injected lock failure");
      }
      if (args.includes("update-ref") && args.includes("-d") && failRefDeletion) {
        failRefDeletion = false;
        throw new Error("injected ref deletion failure");
      }
      return fixture.runGit(args);
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: { runGit },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "partially-applied",
      diagnosticCode: "WORKTREE_ROLLBACK_FINALIZE_PENDING",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, entryId))).toBe(true);
    const interrupted = quarantineEntrySchema.parse(await readJsonFile(manifestPath));
    expect(interrupted.status).toBe("recovery-ref-created");

    const restored = await undoWorktreeQuarantine(interrupted, {
      manifestPath,
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
      },
    });

    expect(restored.status).toBe("restored");
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("rolls back when contents race after the atomic move", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-race",
        entryId: "entry-race",
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          move: async (source, destination) => {
            await rename(source, destination);
            if (source === fixture.action.target.path) {
              await writeFile(join(destination, "README.md"), "changed fixture!\n");
            }
          },
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "rolled-back",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await readFile(join(fixture.linked, "README.md"), "utf8")).toBe("changed fixture!\n");
  });

  it("rolls back when the post-repair fingerprint differs from the plan", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    let measurements = 0;

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-post-repair-fingerprint",
        entryId: "entry-post-repair-fingerprint",
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          measure: async (path, options) => {
            const measurement = await measurePath(path, options);
            measurements += 1;
            return measurements === 3
              ? { ...measurement, fingerprint: "f".repeat(64) }
              : measurement;
          },
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "rolled-back",
    });

    expect(measurements).toBe(3);
    expect(await missing(fixture.linked)).toBe(false);
    expect(
      await missing(worktreeQuarantinePath(fixture.action, "entry-post-repair-fingerprint")),
    ).toBe(true);
  });

  it("stops when a process acquires the worktree at the mutation boundary", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const entryId = "entry-process-race";
    const runId = "run-process-race";

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId,
        entryId,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({
            status: "busy",
            matches: [{ pid: 123, source: "cwd", path: fixture.linked }],
          }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "skipped-stale",
    });

    expect(await missing(fixture.linked)).toBe(false);
    expect(await missing(worktreeQuarantinePath(fixture.action, entryId))).toBe(true);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        worktreeRecoveryRef(fixture.action, runId),
      ]),
    ).rejects.toThrow();
  });

  it("stops when the Git index changes after the earlier audit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    let injected = false;
    const runGit = async (args: string[]) => {
      const output = await fixture.runGit(args);
      if (args.includes("update-ref") && !args.includes("-d") && !injected) {
        injected = true;
        const blob = (
          await fixture.runGit(["-C", fixture.linked, "rev-parse", "HEAD:README.md"])
        ).trim();
        await fixture.runGit([
          "-C",
          fixture.linked,
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blob},INDEX_ONLY.txt`,
        ]);
      }
      return output;
    };

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-index-race",
        entryId: "entry-index-race",
        quarantineDirectory,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "skipped-stale",
    });

    expect(await missing(fixture.linked)).toBe(false);
  });

  it("rolls back when a process acquires the quarantined path before commit", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");

    await expect(
      executeWorktreeQuarantine(fixture.action, {
        runId: "run-final-process-race",
        entryId: "entry-final-process-race",
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async (path) =>
            path === fixture.linked
              ? { status: "idle", matches: [] }
              : { status: "busy", matches: [{ pid: 456, source: "cwd", path }] },
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      name: WorktreeExecutionError.name,
      outcome: "rolled-back",
    });

    expect(await missing(fixture.linked)).toBe(false);
  });
});
