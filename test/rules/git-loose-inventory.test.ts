import { writeFileSync } from "node:fs";
import { mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as git from "../../src/adapters/git/inventory-command.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import * as storage from "../../src/core/storage-observation.js";
import { inventoryLooseObjects } from "../../src/rules/git/inventory-loose.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { runFixtureGit } from "../helpers/git.js";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-loose-fanout-")));
  const common = join(root, "repo");
  await runFixtureGit(["init", "--bare", "--object-format=sha1", common]);
  const fanout = join(common, "objects", "aa");
  await mkdir(fanout);
  await writeFile(join(fanout, "1".repeat(38)), "first");
  const second = join(fanout, "2".repeat(38));
  const mounts = parseStorageMounts("linux", "1 0 1:0 / / rw - ext4 /dev/fixture rw");
  return { common, fanout, second, mounts, root };
}

// Git supplies the object format after the parent enumeration and before the first fanout read.
function afterDiscovery(change: () => Promise<void>) {
  const run = git.inventoryGit;
  vi.spyOn(git, "inventoryGit").mockImplementationOnce(async (...args) => {
    const result = await run(...args);
    await change();
    return result;
  });
}

function duringFanout(fanout: string, visit: () => void) {
  const scan = storage.mapDirectStorageEntries;
  vi.spyOn(storage, "mapDirectStorageEntries").mockImplementation(
    (root, mounts, budget, project, filter) =>
      scan(
        root,
        mounts,
        budget,
        (entry) => {
          if (root === fanout) visit();
          return project(entry);
        },
        filter,
      ),
  );
}

it("counts stable names written after fanout discovery and verifies the stamp of its own read", async () => {
  const { common, fanout, second, mounts } = await fixture();
  afterDiscovery(() => writeFile(second, "second"));
  const visit = vi.fn();
  duringFanout(fanout, visit);
  const { report, verifyFanouts } = await inventoryLooseObjects(common, mounts, { remaining: 100 });
  expect(visit).toHaveBeenCalledTimes(2);
  expect(report).toMatchObject({ coverage: "complete", fanoutsComplete: 1, regularNames: 2 });
  // Replacing an unrelated direct object entry needs the actual fanout observation for verification.
  await mkdir(join(common, "objects", "other"));
  expect(await verifyFanouts(mounts)).toBe(true);
  await writeFile(join(fanout, "3".repeat(38)), "after scan");
  expect(await verifyFanouts(mounts)).toBe(false);
});

it.each(["replacement", "symlink"])(
  "withholds a %s at the discovered name before reading its files",
  async (variant) => {
    const { common, fanout, second, mounts, root } = await fixture();
    const moved = join(root, "original");
    afterDiscovery(async () => {
      await rename(fanout, moved);
      if (variant === "symlink") await symlink(moved, fanout);
      else {
        await mkdir(fanout);
        await writeFile(second, "unrelated");
      }
    });
    const visit = vi.fn();
    duringFanout(fanout, visit);
    const { report } = await inventoryLooseObjects(common, mounts, { remaining: 100 });
    expect(visit).not.toHaveBeenCalled();
    expect(report).toMatchObject({ coverage: "changed", fanoutsComplete: 0, regularNames: 0 });
  },
);

it("withholds files when a write changes the fanout during its own enumeration", async () => {
  const { common, fanout, second, mounts } = await fixture();
  const visit = vi.fn(() => writeFileSync(second, "new during scan"));
  duringFanout(fanout, visit);
  const budget = { remaining: 100 };
  const { report } = await inventoryLooseObjects(common, mounts, budget);
  expect(visit).toHaveBeenCalledTimes(1);
  expect(report).toMatchObject({ coverage: "partial", fanoutsComplete: 0, regularNames: 0 });
  expect(budget.remaining).toBeLessThan(100);
});

it("withholds a separately mounted fanout without reading its files", async () => {
  const { common, fanout } = await fixture();
  const mounts = parseStorageMounts(
    "linux",
    ["1 0 1:0 / / rw - ext4 /dev/fixture rw", `2 1 1:1 / ${fanout} rw - ext4 /dev/other rw`].join(
      "\n",
    ),
  );
  const visit = vi.fn();
  duringFanout(fanout, visit);
  const { report } = await inventoryLooseObjects(common, mounts, { remaining: 100 });
  expect(visit).not.toHaveBeenCalled();
  expect(report).toMatchObject({ coverage: "partial", regularNames: 0, withheldEntries: 1 });
});
