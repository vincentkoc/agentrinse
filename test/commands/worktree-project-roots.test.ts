import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inventoryWorktrees } from "../../src/commands/worktrees.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { runFixtureGit } from "../helpers/git.js";

it("withholds derived worktrees behind an ancestor, container or nested same-device mount", async () => {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-project-roots-")));
  const owner = join(home, "owner");
  const root = join(owner, ".claude", "worktrees");
  const checkout = join(root, "task");
  await runFixtureGit(["init", "-b", "main", owner]);
  await runFixtureGit(["-C", owner, "commit", "--allow-empty", "-m", "initial"]);
  await runFixtureGit(["-C", owner, "worktree", "add", "--detach", checkout]);
  await mkdir(join(checkout, "nested"));
  const options = { home, root: [], repo: [owner], projectRoots: true, measure: true };
  const local = parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
  for (const mount of [join(owner, ".claude"), root, join(checkout, "nested")]) {
    const mounts = [...local, { ...local[0]!, path: mount }];
    const report = await inventoryWorktrees(options, {
      environment: {},
      readMounts: async () => mounts,
    });
    expect(report.entries).toEqual([]);
    expect(report.externalRegistrations).toEqual([
      { path: checkout, ownerRepository: owner, presence: "unresolved" },
    ]);
    expect(report.problems).toContainEqual({
      path: mount === join(owner, ".claude") ? mount : root,
      code: "WORKTREE_PROJECT_ROOT_INCOMPLETE",
    });
  }
  const unknown = await inventoryWorktrees(options, {
    environment: {},
    readMounts: async () => undefined,
  });
  expect(unknown.entries).toEqual([]);
  expect(unknown.problems).toEqual([{ path: owner, code: "WORKTREE_PROJECT_MOUNTS_UNAVAILABLE" }]);
});
