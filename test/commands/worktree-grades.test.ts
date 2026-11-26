import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inventoryGit } from "../../src/adapters/git/inventory-command.js";
import { executeWorktreeGrades } from "../../src/commands/worktree-grades.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { runFixtureGit } from "../helpers/git.js";

async function fixture() {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-grade-")));
  const repo = join(home, "owner"),
    target = join(home, "zzz-linked"),
    config = join(home, "config.json");
  const git = (args: string[]) => runFixtureGit(["-C", repo, ...args], { home });
  await runFixtureGit(["init", "-b", "main", repo], { home });
  await writeFile(join(repo, "tracked"), "fixture\n");
  await git(["add", "tracked"]);
  await git(["commit", "-m", "fixture"]);
  await git(["tag", "retained"]);
  await git(["worktree", "add", "-b", "late", target]);
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      adapters: Object.fromEntries(
        ["codex", "claude", "cursor", "copilot", "zed", "opencode", "grok", "openclaw"].map(
          (id) => [id, { enabled: true, root: join(home, id) }],
        ),
      ),
      pins: [{ gitRef: "refs/tags/retained" }],
    }),
  );
  const options = { home, repo: [repo], worktree: [target], config, json: true, redact: false };
  return { home, repo, target, git, options };
}
const native = it.skipIf(!["linux", "darwin"].includes(process.platform));

native(
  "grades a late selection using the full roster, with provider and Git-ref pins and no sibling probes or saved state",
  async () => {
    const { home, repo, target, git, options } = await fixture();
    for (let i = 0; i < 8; i++)
      await git(["worktree", "add", "--detach", join(home, "sibling-" + i)]);
    await writeFile(join(target, "untracked"), "work in progress\n");
    await mkdir(join(home, "codex"));
    await writeFile(
      join(home, "codex", ".codex-global-state.json"),
      JSON.stringify({ "electron-saved-workspace-roots": [target] }),
    );
    const index = join(repo, ".git", "worktrees", "zzz-linked", "index");
    const before = await lstat(index, { bigint: true });
    const seen = new Set<string>();
    const out = JSON.parse(
      await executeWorktreeGrades(options, async (path, args, ...rest) => {
        if (!args.includes("worktree")) seen.add(path);
        return inventoryGit(path, args, ...rest);
      }),
    );
    expect(out.data).toMatchObject({
      registered: 10,
      selected: 1,
      graded: 1,
      unknown: 0,
      rows: [{ state: "protected", path: target }],
    });
    expect(out.data.rows[0].reasons).toEqual(
      expect.arrayContaining(["dirty-worktree", "user-pin"]),
    );
    expect(out.data.rows[0].reasons).not.toContain("main-worktree");
    expect(out.data.rows[0].reasons).toContain("recent-session");
    expect([...seen]).toEqual([target]);
    expect(out.data.rows[0].resourceId).toMatch(/^git:git-worktree:/u);
    expect(JSON.stringify(out)).not.toMatch(/candidateActions|planId|auditId/u);
    expect((await lstat(index, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    await expect(lstat(join(home, ".local", "state", "agentrinse"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
  30_000,
);

native(
  "withholds main, wrong owner, duplicate, alias, missing and registration drift without grading another checkout",
  async () => {
    const { repo, home, target, options, git } = await fixture();
    const alias = join(home, "alias");
    await symlink(target, alias);
    const out = JSON.parse(
      await executeWorktreeGrades({
        ...options,
        redact: true,
        worktree: [repo, alias, target, target, join(home, "missing"), target + "/../zzz-linked"],
      }),
    );
    expect(out.data).toMatchObject({ selected: 6, graded: 0, unknown: 6 });
    expect(out.data.rows.map((r: { reasons: string[] }) => r.reasons[0])).toEqual([
      "main-worktree",
      "registration-unverified",
      "duplicate-selection",
      "duplicate-selection",
      "registration-unverified",
      "nonliteral-path",
    ]);
    expect(JSON.stringify(out)).not.toContain(home);
    const other = join(home, "other");
    await runFixtureGit(["init", "-b", "main", other], { home });
    const wrong = JSON.parse(await executeWorktreeGrades({ ...options, repo: [other] }));
    expect(wrong.data.unknown).toBe(1);
    let reads = 0;
    const changed = JSON.parse(
      await executeWorktreeGrades(options, async (path, args, ...rest) => {
        if (args.includes("worktree") && ++reads === 2) await git(["worktree", "lock", target]);
        return inventoryGit(path, args, ...rest);
      }),
    );
    expect(changed.data.rows[0]).toMatchObject({
      state: "unknown",
      reasons: ["registration-changed"],
    });
  },
);

native("withholds a registered symlink and a nonreciprocal pointer before status", async () => {
  const { home, target, options } = await fixture();
  const physical = join(home, "moved");
  await rename(target, physical);
  await symlink(physical, target);
  const seen: string[] = [];
  const run: typeof inventoryGit = async (path, args, ...rest) => {
    if (args.includes("status")) seen.push(path);
    return inventoryGit(path, args, ...rest);
  };
  expect(JSON.parse(await executeWorktreeGrades(options, run)).data.rows[0].reasons).toEqual([
    "checkout-identity-unverified",
  ]);
  const marker = join(physical, ".git");
  const admin = (await readFile(marker, "utf8")).trim().slice("gitdir: ".length);
  // Restore the real directory, then corrupt only the fixture's pointer back to the common directory.
  await unlink(target);
  await rename(physical, target);
  await writeFile(join(admin, "commondir"), "../../..\n");
  expect(JSON.parse(await executeWorktreeGrades(options, run)).data.rows[0].state).toBe("unknown");
  expect(seen).toEqual([]);
});

it("rejects an unbounded request or multiple owners", async () => {
  const options = { repo: ["/owner"], home: "/fixture", worktree: [], redact: false, json: true };
  await expect(executeWorktreeGrades(options)).rejects.toThrow("1 to 64");
  await expect(
    executeWorktreeGrades({ ...options, worktree: Array(65).fill("/x") }),
  ).rejects.toThrow("1 to 64");
  await expect(executeWorktreeGrades({ ...options, repo: ["/one", "/two"] })).rejects.toThrow(
    "one literal",
  );
});

native(
  "withholds an external clean filter before status and leaves the selected checkout unchanged",
  async () => {
    const { target, options, git } = await fixture();
    await git(["config", "filter.example.clean", "false"]);
    await writeFile(join(target, ".gitattributes"), "tracked filter=example\n");
    let statusCalls = 0;
    const output = JSON.parse(
      await executeWorktreeGrades(options, (path, args, ...rest) => {
        if (args.includes("status")) statusCalls++;
        return inventoryGit(path, args, ...rest);
      }),
    );
    expect(output.data.rows[0]).toMatchObject({
      state: "unknown",
      reasons: ["git-read-only-inspection-unavailable"],
    });
    expect(statusCalls).toBe(0);
  },
);
