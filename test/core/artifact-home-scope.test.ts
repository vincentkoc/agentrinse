import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactAuditAdapter, type ProcessProbe } from "../../src/adapters/artifacts/adapter.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { artifactNameSchema, type ArtifactRemoveAction } from "../../src/contracts/action.js";
import { revalidateArtifactRemove } from "../../src/core/artifact-revalidation.js";
import { measurePath } from "../../src/core/measure.js";

// No cleanup is executed: exercise discovery and old-plan revalidation only.
describe("artifact projects equal to the audited home", () => {
  it.each(
    artifactNameSchema.options.flatMap((name) =>
      (["direct", "dot", "parent", "alias"] as const).map((form) => ({ name, form })),
    ),
  )("refuses $name with $form spelling before ownership probes", async ({ name, form }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-home-scope-")));
    const target = join(home, name);
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "synthetic user state");
    const projectRoot =
      form === "dot"
        ? `${home}/.`
        : form === "parent"
          ? `${home}/child/..`
          : form === "alias"
            ? join(home, "alias")
            : home;
    if (form === "parent") await mkdir(join(home, "child"));
    if (form === "alias") await symlink(home, projectRoot, "dir");
    const config = structuredClone(DEFAULT_CONFIG);
    config.artifacts.projects = [{ root: projectRoot, names: [name] }];
    config.artifacts.minAgeMinutes = 0;
    config.artifacts.minBytes = 0;
    const processProbe = vi.fn<ProcessProbe>(async () => ({ status: "idle", matches: [] }));
    const adapter = new ArtifactAuditAdapter(
      { ...config.artifacts, ...config.audit },
      processProbe,
      async () => ({ status: "clear", paths: [] }),
    );
    const context = { home, now: new Date(), auditId: "home-scope" };
    const probe = await adapter.probe(context);
    expect(probe.status).toBe("degraded");
    expect(probe.diagnostics).toContainEqual(
      expect.objectContaining({
        code: form === "alias" ? "ARTIFACT_PROJECT_INVALID" : "ARTIFACT_PROJECT_IS_HOME",
      }),
    );
    expect((await adapter.collect(context, probe)).resources).toEqual([]);

    // A saved plan from an older version must not bypass the new scope rule.
    const stats = await stat(target);
    const measurement = await measurePath(target, { maxEntries: 100 });
    const action: ArtifactRemoveAction = {
      actionId: "home-action",
      type: "artifacts.remove",
      adapter: "artifacts",
      resourceId: "home-artifact",
      risk: "safe",
      description: "synthetic old plan",
      expectedReclaimBytes: measurement.bytes,
      target: {
        path: `${projectRoot}/${name}`,
        projectRoot,
        name,
        device: stats.dev,
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        measuredBytes: measurement.bytes,
        newestMtimeMs: measurement.newestMtimeMs,
        fingerprint: measurement.fingerprint,
      },
    };
    await expect(
      revalidateArtifactRemove(action, home, config, { cwd: home, processProbe }),
    ).resolves.toMatchObject({
      status: "stale",
      diagnostic: { code: form === "alias" ? "ARTIFACT_TYPE_CHANGED" : "ARTIFACT_PROJECT_IS_HOME" },
    });
    expect(processProbe).not.toHaveBeenCalled();
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("synthetic user state");
  });
});
