import { link, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { describe, expect, it, vi } from "vitest";
import { ArtifactAuditAdapter } from "../../src/adapters/artifacts/adapter.js";
import * as projectFiles from "../../src/core/project-file.js";
import { collectViteProjectCache } from "../../src/rules/vite/project-cache.js";
import { artifactNameSchema } from "../../src/contracts/action.js";
import type { MountBoundaryResult } from "../../src/core/mount-boundaries.js";

async function fixture() {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-vite-")));
  const project = join(home, "app");
  const modules = join(project, "node_modules");
  const dir = join(modules, ".vite");
  await mkdir(dir, { recursive: true });
  const manifest = join(project, "package.json");
  await writeFile(manifest, JSON.stringify({ devDependencies: { vite: "^8" } }));
  const observe = async (mounts: MountBoundaryResult = { status: "clear", paths: [] }) => {
    const context = { home, now: new Date(), auditId: "vite-fixture" };
    const adapter = new ArtifactAuditAdapter(
      {
        projects: [{ root: project, names: ["dist"] }],
        minBytes: 0,
        minAgeMinutes: 0,
        measureBytes: true,
        maxEntries: 1,
        processCheck: "required",
      },
      async () => {
        throw new Error("holder probe must not run");
      },
      async () => mounts,
    );
    const { resources, diagnostics } = await adapter.collect(context, await adapter.probe(context));
    expect(diagnostics).toEqual([]);
    return Promise.all(resources.map((resource) => adapter.classify(context, resource)));
  };
  return { home, project, modules, dir, manifest, observe };
}

describe("Vite project cache inventory", () => {
  it("rejects an absent cache before mount inspection or any manifest content read", async () => {
    const { home, project, dir } = await fixture();
    const context = { home, now: new Date(), auditId: "absent-vite" };
    const mounts = vi.fn(async (): Promise<MountBoundaryResult> => ({
      status: "clear",
      paths: [],
    }));
    const read = vi.spyOn(projectFiles, "readProjectFile");
    try {
      expect(await collectViteProjectCache(context, project, mounts)).toBeDefined();
      expect(read).toHaveBeenCalledOnce();
      expect(mounts).toHaveBeenCalledOnce();
      read.mockClear();
      mounts.mockClear();
      await rm(dir, { recursive: true });
      expect(await collectViteProjectCache(context, project, mounts)).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
      expect(mounts).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("reports only the default path for projects declaring a direct dependency", async () => {
    const { project, dir, manifest, observe } = await fixture();
    await writeFile(
      join(project, "vite.config.mjs"),
      'throw new Error("must not execute Vite config");',
    );
    await writeFile(join(dir, "large-file"), "x".repeat(8192));
    for (const key of ["dependencies", "devDependencies"]) {
      await writeFile(manifest, JSON.stringify({ [key]: { vite: "^8" } }));
      const findings = await observe();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        state: "protected",
        resource: { kind: "agent-cache", path: dir },
        candidateActions: [],
        estimatedReclaimBytes: 0,
        roots: [{ code: "vite-project-cache" }],
      });
      expect(findings[0]).not.toHaveProperty("measuredBytes");
    }
    expect(artifactNameSchema.safeParse("node_modules/.vite").success).toBe(false);
    expect(artifactNameSchema.safeParse(".vite").success).toBe(false);
  });
  it("skips absent directories, siblings, invalid or oversized manifests and undeclared projects", async () => {
    const { dir, manifest, observe } = await fixture();
    for (const text of [
      "{",
      JSON.stringify({ peerDependencies: { vite: "1" } }),
      JSON.stringify({ dependencies: { vitepress: "1" } }),
      JSON.stringify({ dependencies: { vite: "1" }, notes: "x".repeat(256 * 1024) }),
    ]) {
      await writeFile(manifest, text);
      expect(await observe()).toEqual([]);
    }
    await writeFile(manifest, JSON.stringify({ dependencies: { vite: "1" } }));
    await rename(dir, dir + "-old");
    expect(await observe()).toEqual([]);
  });
  it("refuses linked components, linked manifests and mount ancestors", async () => {
    const { home, modules, dir, manifest, observe } = await fixture();
    expect(await observe({ status: "blocked", paths: [modules] })).toEqual([]);
    expect(await observe({ status: "unknown", paths: [], reason: "unavailable" })).toEqual([]);
    await link(manifest, manifest + "-alias");
    expect(await observe()).toEqual([]);
    await rm(manifest + "-alias");
    for (const path of [manifest, dir, modules]) {
      await rename(path, path + "-real");
      await symlink(path + "-real", path);
      expect(await observe()).toEqual([]);
      await rm(path);
      await rename(path + "-real", path);
    }
    expect(
      await observe({ status: "blocked", paths: [join(home, "unrelated-mount")] }),
    ).toHaveLength(1);
  });
});
