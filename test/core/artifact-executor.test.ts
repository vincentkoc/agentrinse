import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ArtifactRemoveAction } from "../../src/contracts/action.js";
import { ArtifactExecutionError, executeArtifactRemove } from "../../src/core/artifact-executor.js";
import { measurePath } from "../../src/core/measure.js";

async function fixture(): Promise<{
  action: ArtifactRemoveAction;
  project: string;
  target: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agentrinse-execute-"));
  const project = join(root, "project");
  const target = join(project, "node_modules");
  await mkdir(target, { recursive: true });
  await writeFile(join(project, "source.ts"), "keep");
  await writeFile(join(target, "cache.bin"), "remove");
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
  it("isolates and removes only the planned artifact", async () => {
    const value = await fixture();
    const result = await executeArtifactRemove(value.action, {
      id: () => "success",
    });

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
});
