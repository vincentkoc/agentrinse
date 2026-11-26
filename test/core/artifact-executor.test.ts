import { lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ArtifactRemoveAction } from "../../src/contracts/action.js";
import {
  ArtifactExecutionError,
  artifactIsolationPath,
  executeArtifactRemove,
} from "../../src/core/artifact-executor.js";
import { measurePath } from "../../src/core/measure.js";
import { assertDestructiveFixtureRoot } from "../../src/core/safety.js";
import { runFixtureGit } from "../helpers/git.js";

async function fixture(nested = false): Promise<{
  action: ArtifactRemoveAction;
  project: string;
  target: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentrinse-execute-"));
  await assertDestructiveFixtureRoot(root);
  const project = join(root, "project");
  const target = join(project, "node_modules");
  await mkdir(target, { recursive: true });
  await writeFile(join(project, "source.ts"), "keep");
  await writeFile(join(target, "cache.bin"), "remove");
  if (nested) await mkdir(join(target, "cache"));
  const stats = await stat(target);
  const measurement = await measurePath(target, { maxEntries: 100 });
  return {
    project,
    target,
    action: {
      actionId: "action-1",
      type: "artifacts.remove",
      adapter: "artifacts",
      resourceId: "resource-1",
      risk: "safe",
      description: "remove fixture artifact",
      expectedReclaimBytes: measurement.bytes,
      target: {
        path: target,
        projectRoot: project,
        name: "node_modules",
        device: stats.dev,
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        measuredBytes: measurement.bytes,
        newestMtimeMs: measurement.newestMtimeMs,
        fingerprint: measurement.fingerprint,
      },
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("executeArtifactRemove", () => {
  it("restores history added deep in the isolated tree during the last owner refresh", async () => {
    const value = await fixture(true);
    await expect(
      executeArtifactRemove(value.action, {
        processProbe: async () => ({ status: "idle", matches: [] }),
        revalidateProtection: async (path) => {
          await mkdir(join(path, "cache", ".codex"));
          await writeFile(join(path, "cache", ".codex", "session.jsonl"), "keep");
        },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      message: expect.stringContaining("protected agent state"),
    });
    expect(await readFile(join(value.target, "cache", ".codex", "session.jsonl"), "utf8")).toBe(
      "keep",
    );
  });
  it("restores history inserted into an existing deep directory by the second authorization refresh", async () => {
    const value = await fixture(true);
    let refreshes = 0;
    await expect(
      executeArtifactRemove(value.action, {
        processProbe: async () => ({ status: "idle", matches: [] }),
        revalidateProtection: async (path) => {
          if (++refreshes !== 2) return;
          await mkdir(join(path, "cache", ".codex"));
          await writeFile(join(path, "cache", ".codex", "history.jsonl"), "preserve");
        },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      message: expect.stringContaining("final authorization"),
    });
    expect(refreshes).toBe(2);
    expect(await readFile(join(value.target, "cache", ".codex", "history.jsonl"), "utf8")).toBe(
      "preserve",
    );
  });

  it("restores an isolated artifact if its provider claims it before removal", async () => {
    const value = await fixture();
    await expect(
      executeArtifactRemove(value.action, {
        processProbe: async () => ({ status: "idle", matches: [] }),
        revalidateProtection: async () => {
          throw new Error("OpenClaw claimed the workspace");
        },
      }),
    ).rejects.toMatchObject({ outcome: "rolled-back" });
    expect(await readFile(join(value.target, "cache.bin"), "utf8")).toBe("remove");
  });
  it("restores an isolated artifact when Git starts tracking its files", async () => {
    const value = await fixture();
    await runFixtureGit(["-C", value.project, "init", "--quiet"], { home: value.project });
    await runFixtureGit(["-C", value.project, "add", "node_modules/cache.bin"], {
      home: value.project,
    });

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "tracked-artifact",
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).rejects.toMatchObject({ outcome: "rolled-back" });

    expect(await readFile(join(value.target, "cache.bin"), "utf8")).toBe("remove");
    expect(await exists(artifactIsolationPath(value.action, "tracked-artifact"))).toBe(false);
  });

  it("refreshes authority again if a provider claims the artifact during final measurement", async () => {
    const value = await fixture();
    let scans = 0;
    await expect(
      executeArtifactRemove(value.action, {
        measure: async (path, options) => {
          scans++;
          return measurePath(path, options);
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
        revalidateProtection: async () => {
          if (scans === 2) throw new Error("new provider claim");
        },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      message: expect.stringContaining("ownership changed"),
    });
    expect(await readFile(join(value.target, "cache.bin"), "utf8")).toBe("remove");
  });

  it("isolates and removes only the planned artifact", async () => {
    const value = await fixture();
    let nowMs = 0;
    const checkedPaths: string[] = [];
    const result = await executeArtifactRemove(value.action, {
      id: () => "success",
      authorization: { expiresAtMs: 2, now: () => new Date(nowMs) },
      revalidateBeforeIsolation: async () => {
        checkedPaths.push(value.target);
        nowMs = 1;
      },
      revalidateProtection: async (isolated) => {
        checkedPaths.push(isolated);
      },
      processProbe: async () => ({ status: "idle", matches: [] }),
    });

    expect(checkedPaths).toEqual([value.target, result.isolationPath, result.isolationPath]);
    expect(await exists(value.target)).toBe(false);
    expect(await exists(result.isolationPath)).toBe(false);
    expect(await readFile(join(value.project, "source.ts"), "utf8")).toBe("keep");
    expect(result.reclaimedBytes).toBe(value.action.target.measuredBytes);
  });

  it("restores the original path when removal fails before deleting content", async () => {
    const value = await fixture();

    let caught: unknown;
    try {
      await executeArtifactRemove(value.action, {
        id: () => "remove-failure",
        remove: async () => {
          throw new Error("injected remove failure");
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ArtifactExecutionError);
    expect(caught).toMatchObject({
      outcome: "partially-applied",
      isolationPath: value.target,
    });
    expect(await exists(value.target)).toBe(true);
    expect(await readFile(join(value.target, "cache.bin"), "utf8")).toBe("remove");
  });

  it("rolls back when the isolated inode does not match the plan", async () => {
    const value = await fixture();
    const isolationPath = join(value.project, ".agentrinse-identity-race.tombstone");

    let caught: unknown;
    try {
      await executeArtifactRemove(value.action, {
        id: () => "identity-race",
        inspect: async (path) => {
          const stats = await lstat(path);
          if (path === isolationPath) {
            Object.defineProperty(stats, "ino", {
              value: stats.ino + 1,
            });
          }
          return stats;
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      outcome: "rolled-back",
      isolationPath: value.target,
    });
    expect(await exists(value.target)).toBe(true);
    expect(await exists(isolationPath)).toBe(false);
  });

  it("rolls back when contents change after isolation", async () => {
    const value = await fixture();

    let caught: unknown;
    try {
      await executeArtifactRemove(value.action, {
        id: () => "content-race",
        move: async (source, destination) => {
          await rename(source, destination);
          if (source === value.target) {
            // Size must change: same-length overwrites can keep size+mtime (and thus
            // the measurement fingerprint) identical on coarse-timestamp filesystems.
            await writeFile(join(destination, "cache.bin"), "changed-content");
          }
        },
        processProbe: async () => ({
          status: "idle",
          matches: [],
        }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      outcome: "rolled-back",
      isolationPath: value.target,
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("rolls back when an unsupported special entry appears during isolation", async () => {
    const value = await fixture();

    let caught: unknown;
    try {
      await executeArtifactRemove(value.action, {
        id: () => "special-entry",
        measure: async (path, options) => ({
          ...(await measurePath(path, options)),
          specialEntries: 1,
        }),
        processProbe: async () => ({ status: "idle", matches: [] }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      outcome: "rolled-back",
      isolationPath: value.target,
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("rolls back when a nested mount boundary is detected", async () => {
    const value = await fixture();

    let caught: unknown;
    try {
      await executeArtifactRemove(value.action, {
        id: () => "mount-boundary",
        mountProbe: async () => ({
          status: "blocked",
          paths: [join(value.target, "mounted")],
        }),
        processProbe: async () => ({
          status: "idle",
          matches: [],
        }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      outcome: "rolled-back",
      isolationPath: value.target,
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("rolls back when a process acquires the isolated tree", async () => {
    const value = await fixture();

    let caught: unknown;
    try {
      await executeArtifactRemove(value.action, {
        id: () => "process-race",
        processProbe: async () => ({
          status: "busy",
          matches: [
            {
              pid: 42,
              source: "fd",
              path: join(value.target, "cache.bin"),
            },
          ],
        }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      outcome: "rolled-back",
      isolationPath: value.target,
    });
    expect(await exists(value.target)).toBe(true);
  });

  it.each(["source", "destination"] as const)(
    "rechecks the %s after the protection refresh",
    async (endpoint) => {
      const value = await fixture();
      const isolation = artifactIsolationPath(value.action, "refresh-race");
      let moved = false;
      const result = executeArtifactRemove(value.action, {
        id: () => "refresh-race",
        revalidateBeforeIsolation: async () => {
          if (endpoint === "source") {
            await rename(value.target, value.target + ".original");
            await mkdir(value.target);
          } else {
            await mkdir(isolation);
          }
        },
        move: async () => {
          moved = true;
        },
      });
      if (endpoint === "source")
        await expect(result).rejects.toMatchObject({
          diagnosticCode: "ARTIFACT_IDENTITY_CHANGED",
          outcome: "skipped-stale",
        });
      else await expect(result).rejects.toThrow("refusing to overwrite");
      expect(moved).toBe(false);
      expect(await exists(value.target)).toBe(true);
    },
  );

  it("does not isolate an artifact after authorization expires", async () => {
    const value = await fixture();
    let moved = false;

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "expired-before-isolation",
        authorization: {
          expiresAtMs: 1,
          now: () => new Date(1),
        },
        move: async () => {
          moved = true;
        },
      }),
    ).rejects.toMatchObject({ outcome: "skipped-stale" });

    expect(moved).toBe(false);
    expect(await exists(value.target)).toBe(true);
  });

  it("skips isolation when authorization expires during the protection refresh", async () => {
    const value = await fixture();
    let nowMs = 0;
    let moved = false;

    await expect(
      executeArtifactRemove(value.action, {
        authorization: { expiresAtMs: 1, now: () => new Date(nowMs) },
        revalidateBeforeIsolation: async () => {
          nowMs = 1;
        },
        move: async () => {
          moved = true;
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "PLAN_EXPIRED_DURING_APPLY",
    });

    expect(moved).toBe(false);
    expect(await exists(value.target)).toBe(true);
  });

  it("classifies a missing pre-isolation target as stale", async () => {
    const value = await fixture();
    await rm(value.target, { recursive: true });

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "missing-before-isolation",
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "ARTIFACT_IDENTITY_CHANGED",
    });
  });

  it("classifies pre-isolation identity drift as stale", async () => {
    const value = await fixture();

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "changed-before-isolation",
        inspect: async (path) => {
          const stats = await lstat(path);
          if (path === value.target) {
            Object.defineProperty(stats, "ino", { value: stats.ino + 1 });
          }
          return stats;
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "ARTIFACT_IDENTITY_CHANGED",
    });
    expect(await exists(value.target)).toBe(true);
  });

  it("rolls back when authorization expires during isolation", async () => {
    const value = await fixture();
    const times = [new Date(0), new Date(1)];
    let removed = false;

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "expired-during-isolation",
        authorization: {
          expiresAtMs: 1,
          now: () => times.shift() ?? new Date(1),
        },
        remove: async () => {
          removed = true;
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).rejects.toMatchObject({ outcome: "rolled-back" });

    expect(removed).toBe(false);
    expect(await exists(value.target)).toBe(true);
  });

  it("reports post-removal inspection errors as partially applied", async () => {
    const value = await fixture();
    let removed = false;

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "postcondition-error",
        inspect: async (path) => {
          if (removed) {
            throw Object.assign(new Error("injected inspection failure"), { code: "EACCES" });
          }
          return lstat(path);
        },
        remove: async (path) => {
          await rm(path, { recursive: true });
          removed = true;
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).rejects.toMatchObject({ outcome: "partially-applied" });

    expect(await exists(value.target)).toBe(false);
  });

  it("refuses a substituted isolation inode at the final removal gate", async () => {
    const value = await fixture();
    const isolationPath = artifactIsolationPath(value.action, "final-identity");
    let removed = false;

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "final-identity",
        finalInspect: (path) => {
          const stats = lstatSync(path);
          Object.defineProperty(stats, "ino", { value: stats.ino + 1 });
          return stats;
        },
        remove: async () => {
          removed = true;
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).rejects.toMatchObject({
      outcome: "partially-applied",
      isolationPath,
    });

    expect(removed).toBe(false);
    expect(await exists(value.target)).toBe(false);
    expect(await exists(isolationPath)).toBe(true);
  });

  it("restores the artifact when final metadata drifts on the planned inode", async () => {
    const value = await fixture();
    let removed = false;

    await expect(
      executeArtifactRemove(value.action, {
        id: () => "final-metadata",
        finalInspect: (path) => {
          const stats = lstatSync(path);
          Object.defineProperty(stats, "mtimeMs", { value: stats.mtimeMs + 1 });
          return stats;
        },
        remove: async () => {
          removed = true;
        },
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      isolationPath: value.target,
    });

    expect(removed).toBe(false);
    expect(await exists(value.target)).toBe(true);
  });
});
