import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ArtifactRemoveAction } from "../../src/contracts/action.js";
import { measurePath } from "../../src/core/measure.js";
import { revalidateArtifactRemove } from "../../src/core/artifact-revalidation.js";

async function fixture(): Promise<{
  action: ArtifactRemoveAction;
  config: typeof DEFAULT_CONFIG;
  home: string;
  project: string;
  target: string;
}> {
  const home = realpathSync(await mkdtemp(join(tmpdir(), "agentrinse-revalidate-")));
  const project = join(home, "project");
  const target = join(project, "node_modules");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "fixture.txt"), "fixture");
  const stats = await stat(target);
  const measurement = await measurePath(target, { maxEntries: 100 });
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    artifacts: {
      ...structuredClone(DEFAULT_CONFIG.artifacts),
      projects: [{ root: project, names: ["node_modules" as const] }],
      minBytes: 0,
      minAgeMinutes: 0,
    },
  };
  const action: ArtifactRemoveAction = {
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
  };
  return { action, config, home, project, target };
}

describe("revalidateArtifactRemove", () => {
  it("accepts an unchanged idle artifact", async () => {
    const value = await fixture();

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it("rejects an artifact whose contents changed", async () => {
    const value = await fixture();
    await writeFile(join(value.target, "changed.txt"), "changed");

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_IDENTITY_CHANGED" },
    });
  });

  it("rejects same-size in-place descendant changes", async () => {
    const value = await fixture();
    const path = join(value.target, "fixture.txt");
    await writeFile(path, "changed");
    const changedAt = new Date(value.action.target.newestMtimeMs + 10_000);
    await utimes(path, changedAt, changedAt);

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        processProbe: async () => ({
          status: "idle",
          matches: [],
        }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_CONTENT_CHANGED" },
    });
  });

  it("rejects an artifact owned by a process", async () => {
    const value = await fixture();

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        processProbe: async () => ({
          status: "busy",
          matches: [{ pid: 42, source: "cwd", path: value.target }],
        }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_PROCESS_ACTIVE" },
    });
  });

  it("rejects deleting the current working directory or an ancestor", async () => {
    const value = await fixture();

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: join(value.target, "nested"),
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_OWNS_CWD" },
    });
  });
});
