import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectArtifactGitState, runArtifactGit } from "../../src/core/artifact-git-state.js";
import { runFixtureGit } from "../helpers/git.js";

describe("inspectArtifactGitState", () => {
  it("denies even local-file transport during artifact Git inspection", async () => {
    const project = createFixtureDirectory(join(tmpdir(), "agentrinse-offline-git-"));
    await runFixtureGit(["init"], { cwd: project });
    await expect(runArtifactGit(project, ["ls-remote", project])).rejects.toThrow(
      "transport 'file' not allowed",
    );
  });

  it("protects an artifact when Git indexed its name with different casing", async () => {
    const root = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-git-case-")));
    const indexed = join(root, "Node_Modules");
    await mkdir(indexed);
    await writeFile(join(indexed, "tracked.txt"), "synthetic tracked content");
    await runFixtureGit(["-C", root, "init", "--quiet"], { home: root });
    await runFixtureGit(["-C", root, "add", "Node_Modules/tracked.txt"], { home: root });
    await rename(indexed, join(root, "node_modules"));

    await expect(inspectArtifactGitState(root, "node_modules")).resolves.toEqual({
      status: "tracked",
    });
  });

  it("does not match a similarly named sibling directory", async () => {
    const root = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-git-sibling-")));
    const sibling = join(root, "node_modules_old");
    await mkdir(sibling);
    await writeFile(join(sibling, "tracked.txt"), "synthetic tracked content");
    await runFixtureGit(["-C", root, "init", "--quiet"], { home: root });
    await runFixtureGit(["-C", root, "add", "node_modules_old/tracked.txt"], { home: root });

    await expect(inspectArtifactGitState(root, "node_modules")).resolves.toEqual({
      status: "clear",
    });
  });
});
