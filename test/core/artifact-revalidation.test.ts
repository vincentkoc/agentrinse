import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, stat, symlink, utimes, writeFile } from "node:fs/promises";
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

  it("rejects an artifact that no longer meets the size threshold", async () => {
    const value = await fixture();
    value.config.artifacts.minBytes = value.action.target.measuredBytes + 1;

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_POLICY_CHANGED" },
    });
  });

  it("rejects an artifact that no longer meets the age threshold", async () => {
    const value = await fixture();
    value.config.artifacts.minAgeMinutes = 60;

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        now: () => new Date(value.action.target.newestMtimeMs + 30 * 60_000),
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_POLICY_CHANGED" },
    });
  });

  it("rejects unsupported special filesystem entries", async () => {
    const value = await fixture();

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        measure: async () => ({
          bytes: value.action.target.measuredBytes,
          entries: 3,
          symlinksSkipped: 0,
          specialEntries: 1,
          truncated: false,
          newestMtimeMs: value.action.target.newestMtimeMs,
          fingerprint: value.action.target.fingerprint,
          mountBoundaries: 0,
        }),
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_SPECIAL_ENTRY" },
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

  it("rejects an artifact containing a mount boundary", async () => {
    const value = await fixture();

    await expect(
      revalidateArtifactRemove(value.action, value.home, value.config, {
        cwd: value.project,
        mountProbe: async () => ({
          status: "blocked",
          paths: [join(value.target, "mounted")],
        }),
        processProbe: async () => ({
          status: "idle",
          matches: [],
        }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_MOUNT_BOUNDARY" },
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

  it("rejects an artifact reached through a symlinked project alias", async () => {
    const value = await fixture();
    const aliasParent = join(value.home, "alias");
    const aliasProject = join(aliasParent, "project");
    await symlink(value.home, aliasParent, "dir");
    const aliasTarget = join(aliasProject, "node_modules");
    const stats = await stat(aliasTarget);
    const measurement = await measurePath(aliasTarget, { maxEntries: 100 });
    const action: ArtifactRemoveAction = {
      ...value.action,
      target: {
        ...value.action.target,
        path: aliasTarget,
        projectRoot: aliasProject,
        device: stats.dev,
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        measuredBytes: measurement.bytes,
        newestMtimeMs: measurement.newestMtimeMs,
        fingerprint: measurement.fingerprint,
      },
    };
    value.config.artifacts.projects = [{ root: aliasProject, names: ["node_modules"] }];

    await expect(
      revalidateArtifactRemove(action, value.home, value.config, {
        cwd: value.home,
        processProbe: async () => ({ status: "idle", matches: [] }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: "ARTIFACT_REALPATH_CHANGED" },
    });
  });
});
