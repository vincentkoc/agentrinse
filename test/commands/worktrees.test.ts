import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { executeWorktreesCommand, inventoryWorktrees } from "../../src/commands/worktrees.js";
import {
  readGwtStatus,
  lifecycleFor,
  ownerSignoffFor,
} from "../../src/commands/worktree-lifecycle.js";
import { runFixtureGit } from "../helpers/git.js";

const homes: string[] = [];
async function fixture() {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-worktrees-")));
  homes.push(home);
  return home;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const input = (rows: unknown) => Readable.from([Buffer.from(JSON.stringify(rows))]);
const status = (worktree: string, state = "finished") => ({
  worktree,
  state,
  checkout: "retained",
  retirement_state: "enrolled",
  pins: [],
  owners: [{ owner: "test-owner", completed: 1 }],
  released_owners: ["test-owner"],
});

describe("worktree inventory", () => {
  it("correlates native Git registrations, owner status, missing administrative files and bounded bytes", async () => {
    const home = await fixture();
    const root = join(home, ".codex", "worktrees");
    const group = join(root, "project");
    const owner = join(home, "owner");
    const checkout = join(group, "task");
    const gone = join(group, "gone");
    const historical = join(group, "historical");
    await mkdir(group, { recursive: true });
    await runFixtureGit(["init", "-b", "main", owner]);
    await runFixtureGit(["-C", owner, "commit", "--allow-empty", "-m", "initial"]);
    await runFixtureGit([
      "-C",
      owner,
      "worktree",
      "add",
      "--lock",
      "--reason",
      "gwt-finish.v2:00000000-0000-0000-0000-000000000000",
      checkout,
      "-b",
      "task",
    ]);
    await runFixtureGit(["-C", owner, "worktree", "add", gone, "-b", "gone"]);
    await rm(gone, { recursive: true });
    const outside = join(home, "external");
    await runFixtureGit(["-C", owner, "worktree", "add", outside, "-b", "external"]);
    await writeFile(join(checkout, "data.txt"), "retained source");
    await runFixtureGit(["init", join(group, "standalone")]);
    await mkdir(join(group, "unregistered"));
    await writeFile(join(group, "unregistered", ".git"), "gitdir: missing\n");
    const rows = [
      status(checkout),
      { ...status(historical), checkout: "removed", retirement_state: "removed" },
    ];
    const opts = {
      home,
      root: [root, group, root],
      repo: [owner],
      measure: true,
      maxEntries: "1",
      gwtStatusStdin: true,
    };
    const report = await inventoryWorktrees(opts, { environment: {}, input: input(rows) });
    expect(report.summary).toMatchObject({
      registeredLinked: 1,
      standalone: 1,
      missing: 2,
      unresolved: 1,
      historicalMissing: 1,
      nativeCloseoutReview: 1,
      partialMeasurements: 2,
    });
    expect(report.entries.find((e) => e.path === checkout)).toMatchObject({
      kind: "registered-linked",
      ownerRepository: owner,
      locked: true,
      gwtLock: true,
      lifecycle: "finished",
      disposition: "review-native-closeout",
      size: { status: "lower-bound" },
    });
    expect(report.externalRegistrations).toEqual([
      { path: outside, ownerRepository: owner, presence: "directory" },
    ]);
    expect(report.entries.find((e) => e.path === gone)?.adminDirectFileBytes).toBeGreaterThan(0);
    expect(report.entries.find((e) => e.path === historical)?.disposition).toBe("recorded-removed");
    await runFixtureGit(["-C", owner, "worktree", "unlock", checkout]);
    const again = await inventoryWorktrees(
      { ...opts, measure: false },
      { environment: {}, input: input(rows) },
    );
    expect(again.summary.nativeCloseoutReview).toBe(0);
    expect(again.entries.find((e) => e.path === checkout)?.disposition).toBe("retain");
  });

  it("inventories local project containers only for explicitly selected primary checkouts", async () => {
    const home = await fixture();
    const owner = join(home, "project");
    await runFixtureGit(["init", "-b", "main", owner]);
    await runFixtureGit(["-C", owner, "commit", "--allow-empty", "-m", "initial"]);
    const roots = [join(owner, ".worktrees"), join(owner, ".claude", "worktrees")];
    const checkouts = roots.map((root) => join(root, "task"));
    for (const checkout of checkouts)
      await runFixtureGit(["-C", owner, "worktree", "add", "--detach", checkout]);
    const opts = { home, root: [], repo: [owner], measure: true };
    const before = await inventoryWorktrees(opts, { environment: {} });
    expect(before.summary.externalRegisteredDirectories).toBe(2);
    const result = await inventoryWorktrees({ ...opts, projectRoots: true }, { environment: {} });
    expect(result.entries.map((entry) => entry.path).sort()).toEqual(checkouts.sort());
    expect(result.summary).toMatchObject({ registeredLinked: 2, externalRegisteredDirectories: 0 });
    expect(result.entries.every((entry) => entry.size?.status === "complete")).toBe(true);
    expect(result.problems).toEqual([]);
    const linked = await inventoryWorktrees(
      { ...opts, repo: [checkouts[0]!], projectRoots: true },
      { environment: {} },
    );
    expect(linked.problems).toContainEqual({
      path: checkouts[0],
      code: "WORKTREE_PROJECT_OWNER_REQUIRED",
    });
    await expect(inventoryWorktrees({ ...opts, repo: [], projectRoots: true })).rejects.toThrow(
      "--repo",
    );
  });

  it("keeps linked project containers opaque and tolerates absent optional containers", async () => {
    const home = await fixture();
    const owner = join(home, "project");
    await runFixtureGit(["init", "-b", "main", owner]);
    const outside = join(home, "other");
    await mkdir(join(outside, "worktrees", "private"), { recursive: true });
    await symlink(outside, join(owner, ".claude"), "dir");
    const result = await inventoryWorktrees(
      { home, root: [], repo: [owner], projectRoots: true },
      { environment: {} },
    );
    expect(result.entries).toEqual([]);
    expect(result.problems).toEqual([
      { path: join(owner, ".claude"), code: "WORKTREE_PROJECT_ROOT_INCOMPLETE" },
    ]);
    expect(result.roots.map((root) => root.path)).toEqual([join(home, ".codex", "worktrees")]);
  });

  it("isolates configured containers and refuses unsafe paths or malformed input", async () => {
    const home = await fixture();
    const root = join(home, "worktrees");
    await mkdir(root);
    expect(
      (
        await inventoryWorktrees(
          { home, root: [], repo: [] },
          { environment: { CODEX_HOME: join(home, "custom"), DOTFILES_WORKTREES_ROOT: root } },
        )
      ).roots,
    ).toHaveLength(3);
    const external = join(home, "outside");
    await mkdir(external);
    await symlink(external, join(root, "linked"), "dir");
    await mkdir(join(external, "private"));
    const report = await inventoryWorktrees({ home, root: [root], repo: [] }, { environment: {} });
    expect(report.entries.map((e) => [e.path, e.kind])).toEqual([
      [join(root, "linked"), "unresolved"],
    ]);
    await expect(
      inventoryWorktrees({ home, root: [home], repo: [] }, { environment: {} }),
    ).rejects.toThrow("Refusing");
    await expect(readGwtStatus(input([{ state: "finished" }]))).rejects.toThrow("Expected");
    const file = join(root, "one");
    const rows = await readGwtStatus(input([status(file), status(file)]));
    expect(lifecycleFor(rows.get(file))).toBe("unresolved");
  });

  it("redacts paths outside the home in JSON and human reports and marks a requested missing root incomplete", async () => {
    const parent = await fixture();
    const home = join(parent, "fake-home");
    const owner = join(parent, "sensitive-owner");
    const root = join(parent, "sensitive-root");
    await mkdir(home);
    await mkdir(root);
    await runFixtureGit(["init", "-b", "main", owner]);
    await runFixtureGit(["-C", owner, "commit", "--allow-empty", "-m", "initial"]);
    await runFixtureGit([
      "-C",
      owner,
      "worktree",
      "add",
      join(root, "sensitive-checkout"),
      "-b",
      "task",
    ]);
    const opts = { home, root: [root, join(parent, "missing")], repo: [owner], redact: true };
    for (const json of [false, true]) {
      const output = await executeWorktreesCommand({ ...opts, json });
      expect(output).not.toContain(parent);
      expect(output).not.toContain("sensitive-");
      expect(output).toContain("degraded");
      expect(output).toContain("$PATH");
    }
  });

  it("requires an enrolled terminal record and complete owner evidence for a closeout review", async () => {
    const home = await fixture();
    const record = status(home);
    for (const [overrides, expected] of [
      [{}, "released"],
      [{ released_owners: [] }, "pending"],
      [{ retirement_state: "report-only" }, "report-only"],
      [
        { state: "cancelled", cancelled_owners: [{ owner: "test-owner", head: "same" }] },
        "cancelled",
      ],
      [
        { state: "cancelled", cancelled_owners: [{ owner: "test-owner", head: "other" }] },
        "pending",
      ],
    ] as const) {
      const rows = await readGwtStatus(input([{ ...record, ...overrides }]));
      expect(ownerSignoffFor(rows.get(home), "same")).toBe(expected);
    }
  });

  it("keeps pinned, interrupted and active records out of native closeout review", async () => {
    const home = await fixture();
    const records = [
      status(join(home, "active"), "active"),
      { ...status(join(home, "pinned")), pins: [{}] },
      { ...status(join(home, "uncertain")), checkout: "unknown" },
      status(join(home, "cancelled"), "cancelled"),
    ];
    const mapped = await readGwtStatus(input(records));
    expect([...mapped.values()].map((rows) => lifecycleFor(rows))).toEqual([
      "active",
      "pinned",
      "unresolved",
      "cancelled",
    ]);
  });
});
