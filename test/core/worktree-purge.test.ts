import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import { quarantineEntrySchema } from "../../src/contracts/quarantine.js";
import { executeWorktreeQuarantine } from "../../src/core/worktree-executor.js";
import { purgeWorktreeQuarantine } from "../../src/core/worktree-purge.js";
import { undoWorktreeQuarantine } from "../../src/core/worktree-undo.js";
import { renameNoReplace } from "../../src/core/no-clobber-rename.js";
import { readJsonFile, writeJsonAtomic } from "../../src/state/json-file.js";
import {
  gitFixture,
  idle,
  lockReason,
  missing,
  persistedStatus,
  quarantined,
} from "./worktree-fixture.js";

describe("worktree quarantine purge", () => {
  it("refuses undo and purge after a foreign worktree lock replaces its lock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-foreign-lock",
      entryId: "entry-foreign-lock",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      "operator hold",
      result.quarantinePath,
    ]);

    await expect(
      undoWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });
    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

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
          locked: "operator hold",
        }),
      ]),
    );
  });

  it("purges an expired unchanged entry through clean Git removal", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const calls: string[][] = [];
    let manifestPath: string | undefined;
    let protectionChecked = false;
    const runGit = async (args: string[]) => {
      calls.push(args);
      if (args.includes("worktree") && args.includes("remove")) {
        expect(protectionChecked).toBe(true);
      }
      if (args.includes("update-ref") && args.includes("-d") && manifestPath !== undefined) {
        const persisted = quarantineEntrySchema.parse(await readJsonFile(manifestPath));
        expect(persisted.status).toBe("purging");
      }
      return fixture.runGit(args);
    };
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge",
      entryId: "entry-purge",
      quarantineDirectory,
      dependencies: {
        runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    manifestPath = result.manifestPath;
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await mkdir(fixture.linked);

    const purged = await purgeWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      revalidateProtection: async () => {
        protectionChecked = true;
      },
      dependencies: {
        runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe(fixture.action.target.measuredBytes);
    expect(await missing(result.quarantinePath)).toBe(true);
    const removeCall = calls.find((args) => args.includes("worktree") && args.includes("remove"));
    expect(removeCall).toBeDefined();
    expect(removeCall).not.toContain("--force");
    expect(await missing(fixture.linked)).toBe(false);
  });

  it("rechecks protection immediately before permanent removal", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    let removeCalled = false;
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("remove")) {
        removeCalled = true;
      }
      return fixture.runGit(args);
    };
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-protection-race",
      entryId: "entry-purge-protection-race",
      quarantineDirectory,
      dependencies: {
        runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        revalidateProtection: async () => {
          throw new Error("new protection root");
        },
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
          clock: () => new Date("2026-07-24T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(removeCalled).toBe(false);
    expect(await missing(result.quarantinePath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("revalidates local state after the final purge protection check", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    let removeCalled = false;
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("remove")) {
        removeCalled = true;
      }
      return fixture.runGit(args);
    };
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-local-race",
      entryId: "entry-purge-local-race",
      quarantineDirectory,
      dependencies: { runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        revalidateProtection: async () => {
          await writeFile(join(isolationPath, ".env"), "arrived during protection scan\n");
        },
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(removeCalled).toBe(false);
    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(result.quarantinePath, ".env"), "utf8")).resolves.toBe(
      "arrived during protection scan\n",
    );
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("refuses purge when a Git operation marker appears after quarantine", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-operation",
      entryId: "entry-purge-operation",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const markerPath = (
      await fixture.runGit(["-C", result.quarantinePath, "rev-parse", "--git-path", "rebase-apply"])
    ).trim();
    await mkdir(markerPath, { recursive: true });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_GIT_OPERATION_IN_PROGRESS",
    });

    expect(await missing(result.quarantinePath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("does not finalize normal purge when the target registration reappears elsewhere", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-relocated",
      entryId: "entry-purge-relocated",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const thirdPath = join(fixture.home, "purge-relocated");
    let removed = false;
    let relocated = false;
    const runGit = async (args: string[]) => {
      const output = await fixture.runGit(args);
      if (args.includes("worktree") && args.includes("remove")) {
        removed = true;
      } else if (removed && !relocated && args.includes("worktree") && args.includes("list")) {
        relocated = true;
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "worktree",
          "add",
          thirdPath,
          fixture.action.target.branch!.replace(/^refs\/heads\//, ""),
        ]);
        return fixture.runGit(args);
      }
      return output;
    };
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FINALIZE_PENDING",
    });

    expect(await missing(thirdPath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "purging",
    );
    expect(
      (
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "rev-parse",
          "--verify",
          result.recoveryRef,
        ])
      ).trim(),
    ).toBe(fixture.action.target.head);
  });

  it("keeps an entry retryable when purge fails before unlock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-unlock",
      entryId: "entry-purge-unlock",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await mkdir(fixture.linked);
    await writeFile(join(fixture.linked, "replacement.txt"), "unrelated replacement\n");
    let lockPathLookups = 0;
    const runGit = async (args: string[]) => {
      if (args.includes("--git-path") && args.includes("locked")) {
        lockPathLookups += 1;
        if (lockPathLookups === 2) {
          throw new Error("injected lock claim failure");
        }
      }
      return fixture.runGit(args);
    };

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    const persisted = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    expect(persisted.status).toBe("quarantined");
    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(fixture.linked, "replacement.txt"), "utf8")).resolves.toBe(
      "unrelated replacement\n",
    );
  });

  it("rolls purge isolation back when ignored content appears before final validation", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-ignored-race",
      entryId: "entry-purge-ignored-race",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;
    let injected = false;
    const runGit = async (args: string[]) => {
      const output = await fixture.runGit(args);
      if (
        !injected &&
        args.includes("worktree") &&
        args.includes("repair") &&
        args.includes(isolationPath)
      ) {
        injected = true;
        await writeFile(join(isolationPath, ".env"), "arrived during purge\n");
      }
      return output;
    };

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(result.quarantinePath, ".env"), "utf8")).resolves.toBe(
      "arrived during purge\n",
    );
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("resumes purge from an atomically isolated worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge-isolated",
      entryId: "entry-resume-purge-isolated",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });
    let protectionChecked = false;
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("remove")) {
        expect(protectionChecked).toBe(true);
      }
      return fixture.runGit(args);
    };

    const purged = await purgeWorktreeQuarantine(purging, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      revalidateProtection: async () => {
        protectionChecked = true;
      },
      dependencies: {
        runGit,
        processProbe: async () => ({ status: "idle", matches: [] }),
        mountProbe: async () => ({ status: "clear", paths: [] }),
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(await missing(isolationPath)).toBe(true);
  });

  it("revalidates local state after resumed purge protection checks", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge-local-race",
      entryId: "entry-resume-purge-local-race",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });
    let removeCalled = false;
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("remove")) {
        removeCalled = true;
      }
      return fixture.runGit(args);
    };

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        revalidateProtection: async () => {
          await writeFile(join(isolationPath, ".env"), "arrived during resumed protection scan\n");
        },
        dependencies: {
          runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(removeCalled).toBe(false);
    expect(await missing(isolationPath)).toBe(true);
    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(result.quarantinePath, ".env"), "utf8")).resolves.toBe(
      "arrived during resumed protection scan\n",
    );
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
  });

  it("checks Git operation markers before repairing isolated purge state", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-isolated-operation",
      entryId: "entry-purge-isolated-operation",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const markerPath = (
      await fixture.runGit(["-C", isolationPath, "rev-parse", "--git-path", "rebase-apply"])
    ).trim();
    await mkdir(markerPath, { recursive: true });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_GIT_OPERATION_IN_PROGRESS",
    });

    expect(await missing(isolationPath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "purging",
    );
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
      expect.arrayContaining([expect.objectContaining({ path: result.quarantinePath })]),
    );
  });

  it("rolls an interrupted purge back when isolated validation fails", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge-rollback",
      entryId: "entry-resume-purge-rollback",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    await writeFile(join(isolationPath, "changed.txt"), "changed after crash\n");
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
          clock: () => new Date("2026-07-24T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_PURGE_FAILED",
    });

    expect(await missing(isolationPath)).toBe(true);
    expect(await missing(result.quarantinePath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "quarantined",
    );
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
          locked: "AgentRinse quarantine entry-resume-purge-rollback",
        }),
      ]),
    );
  });

  it("does not repair isolated purge state protected by a foreign lock", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-isolated-lock",
      entryId: "entry-purge-isolated-lock",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const isolationPath = `${result.quarantinePath}.purging`;
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      "operator hold",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, isolationPath);
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

    expect(await missing(isolationPath)).toBe(false);
    expect(quarantineEntrySchema.parse(await readJsonFile(result.manifestPath)).status).toBe(
      "purging",
    );
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
          locked: "operator hold",
        }),
      ]),
    );
  });

  it("refuses to finalize purge when the target registration moved elsewhere", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-purge-third-path",
      entryId: "entry-purge-third-path",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const thirdPath = join(dirname(result.quarantinePath), "moved-by-operator");
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await renameNoReplace(result.quarantinePath, thirdPath);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "repair",
      thirdPath,
    ]);
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    await expect(
      purgeWorktreeQuarantine(purging, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: { runGit: fixture.runGit },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_REGISTRATION_CHANGED",
    });

    expect(await missing(thirdPath)).toBe(false);
    expect(
      (
        await fixture.runGit([
          "--git-dir",
          fixture.action.target.repositoryCommonDir,
          "rev-parse",
          "--verify",
          result.recoveryRef,
        ])
      ).trim(),
    ).toBe(fixture.action.target.head);
  });

  it("finishes an interrupted purge after Git removed the worktree", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge",
      entryId: "entry-resume-purge",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "remove",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "update-ref",
      "-d",
      result.recoveryRef,
      fixture.action.target.head,
    ]);
    await mkdir(fixture.linked);
    await writeFile(join(fixture.linked, "replacement.txt"), "unrelated replacement\n");
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    let protectionChecked = false;
    const purged = await purgeWorktreeQuarantine(purging, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      revalidateProtection: async () => {
        protectionChecked = true;
      },
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-24T00:00:00.000Z"),
      },
    });

    expect(purged.entry.status).toBe("purged");
    expect(protectionChecked).toBe(false);
    expect(purged.reclaimedBytes).toBe(fixture.action.target.measuredBytes);
    await expect(readFile(join(fixture.linked, "replacement.txt"), "utf8")).resolves.toBe(
      "unrelated replacement\n",
    );
  });

  it("finalizes an already-removed purge without repeating pre-removal protection", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-resume-purge-protected",
      entryId: "entry-resume-purge-protected",
      quarantineDirectory,
      dependencies: { runGit: fixture.runGit },
    });
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "unlock",
      result.quarantinePath,
    ]);
    await fixture.runGit([
      "--git-dir",
      fixture.action.target.repositoryCommonDir,
      "worktree",
      "remove",
      result.quarantinePath,
    ]);
    const purging = quarantineEntrySchema.parse({ ...manifest, status: "purging" });
    await writeJsonAtomic(result.manifestPath, purging, {
      privateDirectories: [quarantineDirectory],
    });

    let protectionChecks = 0;
    const purged = await purgeWorktreeQuarantine(purging, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      revalidateProtection: async () => {
        protectionChecks += 1;
        throw new Error("post-removal protection must not run");
      },
      dependencies: { runGit: fixture.runGit },
    });

    expect(purged.entry.status).toBe("purged");
    expect(protectionChecks).toBe(0);
    await expect(
      fixture.runGit([
        "--git-dir",
        fixture.action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        result.recoveryRef,
      ]),
    ).rejects.toThrow();
  });

  it("refuses purge after quarantined contents change", async () => {
    const fixture = await gitFixture();
    const quarantineDirectory = join(fixture.home, "state", "quarantine");
    const result = await executeWorktreeQuarantine(fixture.action, {
      runId: "run-dirty",
      entryId: "entry-dirty",
      quarantineDirectory,
      dependencies: {
        runGit: fixture.runGit,
        clock: () => new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    await writeFile(join(result.quarantinePath, "changed.txt"), "changed\n");
    const manifest = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: {
          runGit: fixture.runGit,
          processProbe: async () => ({ status: "idle", matches: [] }),
          mountProbe: async () => ({ status: "clear", paths: [] }),
          clock: () => new Date("2026-07-24T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({
      code: "QUARANTINE_IDENTITY_CHANGED",
    });
    expect(await missing(result.quarantinePath)).toBe(false);
  });

  it("refuses to purge an unexpired entry without allowUnexpired", async () => {
    const fixture = await gitFixture();
    const { quarantineDirectory, result, manifest } = await quarantined(fixture, "unexpired");

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        dependencies: { runGit: fixture.runGit, ...idle },
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_NOT_EXPIRED" });

    expect(await persistedStatus(result.manifestPath)).toBe("quarantined");
    expect(await missing(result.quarantinePath)).toBe(false);
    expect(await lockReason(fixture, result.quarantinePath)).toBe(
      "AgentRinse quarantine entry-unexpired",
    );
  });

  it("relocks and keeps the entry when the purge isolation path already exists", async () => {
    const fixture = await gitFixture();
    const { quarantineDirectory, result, manifest } = await quarantined(fixture, "isolation");
    const isolationPath = `${result.quarantinePath}.purging`;
    await mkdir(isolationPath);
    await writeFile(join(isolationPath, "occupant.txt"), "keep\n");

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: { runGit: fixture.runGit, ...idle },
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_PURGE_FAILED" });

    expect(await persistedStatus(result.manifestPath)).toBe("quarantined");
    expect(await missing(result.quarantinePath)).toBe(false);
    await expect(readFile(join(isolationPath, "occupant.txt"), "utf8")).resolves.toBe("keep\n");
    expect(await lockReason(fixture, result.quarantinePath)).toBe(
      "AgentRinse quarantine entry-isolation",
    );
  });

  it("rolls isolation back when Git reports removal but the path remains", async () => {
    const fixture = await gitFixture();
    const { quarantineDirectory, result, manifest } = await quarantined(fixture, "remove-noop");
    const runGit = async (args: string[]) =>
      args.includes("worktree") && args.includes("remove") ? "" : fixture.runGit(args);

    const error = await purgeWorktreeQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory,
      allowUnexpired: true,
      dependencies: { runGit, ...idle },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "QUARANTINE_PURGE_FAILED" });
    expect(await persistedStatus(result.manifestPath)).toBe("quarantined");
    expect(await missing(result.quarantinePath)).toBe(false);
    expect(await missing(`${result.quarantinePath}.purging`)).toBe(true);
    expect(await lockReason(fixture, result.quarantinePath)).toBe(
      "AgentRinse quarantine entry-remove-noop",
    );
  });

  it("records partial state when purge cannot relock after a failed isolation move", async () => {
    const fixture = await gitFixture();
    const { quarantineDirectory, result, manifest } = await quarantined(fixture, "purge-partial");
    const runGit = async (args: string[]) => {
      if (args.includes("worktree") && args.includes("lock")) {
        throw new Error("injected relock failure");
      }
      return fixture.runGit(args);
    };

    await expect(
      purgeWorktreeQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          runGit,
          ...idle,
          move: async () => {
            throw new Error("injected isolation move failure");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_PURGE_PARTIAL" });

    const persisted = quarantineEntrySchema.parse(await readJsonFile(result.manifestPath));
    expect(persisted.status).toBe("partial");
    expect(persisted.diagnostic).toMatchObject({
      code: "QUARANTINE_PURGE_PARTIAL",
      message: "purge left partial state: injected relock failure",
    });
    expect(await missing(result.quarantinePath)).toBe(false);
  });
});
