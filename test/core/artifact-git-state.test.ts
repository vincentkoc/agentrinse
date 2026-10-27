import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { inspectArtifactGitState } from "../../src/core/artifact-git-state.js";

const execFileAsync = promisify(execFile);

describe("inspectArtifactGitState", () => {
  it("protects an artifact when Git indexed its name with different casing", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-git-case-")));
    const indexed = join(root, "Node_Modules");
    await mkdir(indexed);
    await writeFile(join(indexed, "tracked.txt"), "synthetic tracked content");
    await execFileAsync("git", ["-C", root, "init", "--quiet"]);
    await execFileAsync("git", ["-C", root, "add", "Node_Modules/tracked.txt"]);
    await rename(indexed, join(root, "node_modules"));

    await expect(inspectArtifactGitState(root, "node_modules")).resolves.toEqual({
      status: "tracked",
    });
  });

  it("does not match a similarly named sibling directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-git-sibling-")));
    const sibling = join(root, "node_modules_old");
    await mkdir(sibling);
    await writeFile(join(sibling, "tracked.txt"), "synthetic tracked content");
    await execFileAsync("git", ["-C", root, "init", "--quiet"]);
    await execFileAsync("git", ["-C", root, "add", "node_modules_old/tracked.txt"]);

    await expect(inspectArtifactGitState(root, "node_modules")).resolves.toEqual({
      status: "clear",
    });
  });
});
