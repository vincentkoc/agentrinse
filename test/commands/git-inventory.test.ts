import { lstat, link, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeGitInventory,
  inventoryGitOwners,
  type GitInventoryOptions,
} from "../../src/commands/git-inventory.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { runFixtureGit } from "../helpers/git.js";

const mounts = async () => parseStorageMounts("linux", "1 0 1:0 / / rw - ext4 /dev/fixture rw");
async function setup() {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-git-inventory-")));
  const parent = join(home, "repos"),
    repo = join(parent, ".github");
  await mkdir(parent);
  await runFixtureGit(["init", "-b", "main", repo]);
  await runFixtureGit(["-C", repo, "commit", "--allow-empty", "-m", "fixture"]);
  const options: GitInventoryOptions = { home, repo: [], repoRoot: [parent], worktreeRoot: [] };
  return { home, parent, repo, options };
}
const input = (value: unknown) =>
  (async function* () {
    yield Buffer.from(JSON.stringify(value));
  })();
const lock = "gwt-finish.v2:11223344-1234-1234-1234-123456789abc";
describe("git-inventory", () => {
  it("finds dot-prefixed owners and reconciles temp pack aliases, external links and sidecars", async () => {
    const { repo, parent, home, options } = await setup(),
      pack = join(repo, ".git", "objects", "pack");
    const other = join(parent, "second");
    await runFixtureGit(["init", other]);
    await mkdir(join(parent, "unrelated"));
    await mkdir(join(parent, "unrelated", "nested"));
    await runFixtureGit(["init", join(parent, "unrelated", "nested", "repo")]);
    const ordinary = "pack-" + "a".repeat(40);
    const temp = join(pack, "tmp_pack_alpha");
    await writeFile(temp, "1234567");
    await link(temp, join(other, ".git", "objects", "pack", "tmp_pack_beta"));
    await writeFile(join(pack, ordinary + ".pack"), "ordinary");
    await link(join(pack, ordinary + ".pack"), join(pack, "tmp_idx_alias"));
    await writeFile(join(pack, "tmp_x"), "unseen");
    await link(join(pack, "tmp_x"), join(home, "unobserved"));
    for (const ext of ["keep", "promisor", "mtimes", "bitmap", "rev"])
      await writeFile(join(pack, ordinary + "." + ext), ext);
    await writeFile(join(repo, ".git", "objects", "bitmap-ref-tips_example"), "hints");
    await writeFile(join(repo, ".git", "objects", "maintenance.lock"), "");
    const { data, status } = await inventoryGitOwners({ ...options, repo: [repo] }, { mounts });
    expect(status).toBe("ok");
    expect(data.summary).toMatchObject({ commonStores: 2, nonRepositories: 1 });
    expect(data.bytes.temporaryNames).toMatchObject({
      observedNames: 4,
      uniqueIdentities: { files: 3, logicalBytes: "21" },
      allLinksAccountedForAndTemporary: { files: 1, logicalBytes: "7" },
      alsoHasNonTemporaryName: { files: 1, logicalBytes: "8" },
      unobservedLinks: { files: 1, logicalBytes: "6" },
    });
    const result = data.repositories.find((r) => r.path === repo)?.packs;
    expect(result?.pairs).toEqual({ complete: true, packWithoutIndex: 1, indexWithoutPack: 0 });
    expect(result?.maintenanceLockNamePresent).toBe(true);
    for (const kind of [
      "keep",
      "promisor",
      "cruft-mtimes",
      "bitmap",
      "reverse-index",
      "bitmap-ref-tips-name",
    ])
      expect(result?.observedNamesByKind[kind]?.files).toBe(1);
    expect(data.reclaimableBytes).toBeNull();
  });
  it("withholds separate object mounts and redacts explicit private roots in both output formats", async () => {
    const { repo, home, options } = await setup();
    const foreign = await realpath(
      createFixtureDirectory(join(tmpdir(), "agentrinse-external-owner-")),
    );
    const rootMount = "1 0 1:0 / / rw - ext4 /dev/fixture rw";
    const objectMount = "2 1 1:2 / " + join(repo, ".git", "objects") + " rw - ext4 /dev/other rw";
    const environment = {},
      deps = {
        environment,
        mounts: async () => parseStorageMounts("linux", rootMount + "\n" + objectMount),
      };
    const withheld = await inventoryGitOwners({ ...options, repo: [foreign] }, deps);
    expect(withheld.status).toBe("degraded");
    expect(withheld.data.repositories.find((row) => row.path === repo)?.coverage).toBe(
      "mount-boundary",
    );
    expect(withheld.data.bytes.uniqueFiles.files).toBe(0);
    for (const json of [true, false]) {
      const output = await executeGitInventory(
        { ...options, repo: [foreign], redact: true, json },
        deps,
      );
      expect(output).not.toContain(home);
      expect(output).not.toContain(foreign);
      expect(output).toContain("$PATH");
    }
    const unsupported = await inventoryGitOwners(options, {
      environment,
      mounts: async () => undefined,
    });
    expect(unsupported.status).toBe("degraded");
    expect(unsupported.data.repoRoots[0]?.coverage).toBe("unavailable");
  });
  it("counts real loose-object names without following a symlink or an alternate store", async () => {
    const { repo, home, options } = await setup(),
      objects = join(repo, ".git", "objects"),
      dir = join(objects, "aa");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a".repeat(38)), "unopened");
    await writeFile(join(dir, "wrong-length"), "");
    await symlink(join(home, "absent-external"), join(dir, "b".repeat(38)));
    await writeFile(join(objects, "info", "alternates"), join(home, "ignored-alternate"));
    const data = (await inventoryGitOwners({ ...options, looseObjects: true }, { mounts })).data;
    expect(data.repositories[0]?.looseObjects).toMatchObject({
      coverage: "partial",
      objectFormat: "sha1",
      withheldEntries: 1,
    });
    expect(data.summary.looseObjects.regularNames).toBeGreaterThanOrEqual(1);
    expect((await inventoryGitOwners(options, { mounts })).data.summary.looseObjects).toMatchObject(
      { requested: false, regularNames: null },
    );
  });
  it("separates locked and prunable missing registrations, admin files and occupied unrelated directories", async () => {
    const { repo, home, options } = await setup(),
      missing = join(home, "missing"),
      locked = join(home, "locked"),
      occupied = join(repo, ".worktrees", "occupied");
    for (const p of [missing, locked, occupied])
      await runFixtureGit(["-C", repo, "worktree", "add", "--detach", p, "HEAD"]);
    await runFixtureGit(["-C", repo, "worktree", "lock", "--reason", "operator-retained", locked]);
    for (const p of [missing, locked, occupied]) await rm(p, { recursive: true });
    await mkdir(occupied);
    await writeFile(join(occupied, ".git"), "gitdir: ../foreign\n");
    await mkdir(join(repo, ".git", "worktrees", "inert-admin"));
    const { data } = await inventoryGitOwners(options, { mounts });
    expect(data.summary).toMatchObject({
      missing: 2,
      missingLocked: 1,
      missingPrunable: 1,
      reciprocal: 0,
    });
    expect(data.bytes.missingAdminByState["admin-locked"]?.files).toBeGreaterThan(0);
    expect(data.bytes.missingAdminByState["admin-prunable"]?.files).toBeGreaterThan(0);
    const registrations = data.repositories[0]?.worktrees;
    expect(registrations?.entries.find((r) => r.path === occupied)).toMatchObject({
      presence: "present-unverified",
      scope: "project-local",
    });
    expect(registrations?.reasons["absent-backlink"]).toBe(1);
  });
  it("qualifies only exact enrolled identities and preserves an independent sibling when native listing is withheld", async () => {
    const { repo, home, options } = await setup(),
      root = join(home, "legacy"),
      path = join(root, "topic"),
      admin = join(repo, ".git", "worktrees", "topic");
    await runFixtureGit(["-C", repo, "worktree", "add", "-b", "topic", path, "HEAD"]);
    await runFixtureGit([
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/example/project.git",
    ]);
    await runFixtureGit(["-C", repo, "worktree", "lock", "--reason", lock, path]);
    const head = (await runFixtureGit(["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    const identify = async (path: string) => {
      const st = await lstat(path, { bigint: true });
      return { path, dev: String(st.dev), ino: String(st.ino) };
    };
    const row = {
      worktree: path,
      state: "finished",
      checkout: "retained",
      retirement_state: "enrolled",
      generation: 2,
      finish_head: head,
      cancellation_head: null,
      branch: "refs/heads/topic",
      lock_reason: lock,
      pin_count: 0,
      has_intent: false,
      has_result: false,
      owner_count: 1,
      completed_count: 1,
      released_count: 1,
      cancelled_count: 0,
      owner_signoff: "released",
      identity: {
        root,
        repo: "example/project",
        checkout: await identify(path),
        admin: await identify(admin),
        common: await identify(join(repo, ".git")),
        owner: await identify(repo),
      },
    };
    const census = (projection: unknown) =>
      inventoryGitOwners(
        { ...options, worktreeRoot: [root], gwtStatusStdin: true },
        { mounts, input: input(projection) },
      );
    const projected = (r: unknown) => ({
      schema: "gwt-finish-inventory.v1",
      source: "gwt finish-status --all --read-only --inventory-json",
      records: [r],
    });
    expect((await census(projected(row))).data.summary.nativeCloseoutReview).toBe(1);
    const broken = join(repo, ".git", "worktrees", "malformed");
    await mkdir(broken);
    await writeFile(join(broken, "gitdir"), "invalid");
    const fallback = (await census(projected(row))).data;
    expect(fallback.summary).toMatchObject({
      linkedRegistrations: 1,
      nativeListedRegistrations: 0,
      adminBacklinkOnly: 1,
      reciprocal: 1,
    });
    const healthy = fallback.repositories[0]?.worktrees;
    expect(healthy?.entries.find((r) => r.path === path)).toMatchObject({
      presence: "reciprocal",
      source: "admin-backlink",
      nativeReview: "review-native-closeout",
    });
    for (const replacement of [
      { ...row, finish_head: "0".repeat(40) },
      { ...row, has_intent: true },
      { ...row, lock_reason: lock + "x" },
      { ...row, released_count: 0 },
      {
        ...row,
        identity: {
          ...row.identity,
          checkout: { ...row.identity.checkout, ino: "9007199254740993" },
        },
      },
    ]) {
      expect((await census(projected(replacement))).data.summary.nativeCloseoutReview).toBe(0);
    }
    expect(
      (
        await census([
          {
            worktree: path,
            state: "finished",
            checkout: "retained",
            retirement_state: "enrolled",
            pins: [],
            owners: [{ owner: "fixture", completed: 1 }],
            released_owners: ["fixture"],
          },
        ])
      ).data.summary,
    ).toMatchObject({ gwtEvidence: "legacy-signoff-only", nativeCloseoutReview: null });
  });
  it("preserves known owners and withholds pair conclusions when the shared file budget ends", async () => {
    const { repo, parent, options } = await setup();
    for (let i = 0; i < 70; i++) {
      const bare = join(parent, "bare-" + i);
      await mkdir(join(bare, "objects", "pack"), { recursive: true });
      await mkdir(join(bare, "refs", "heads"), { recursive: true });
      await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(bare, "config"), "[core]\n\tbare = true\n");
    }
    await writeFile(join(repo, ".git", "objects", "pack", "tmp_pack_first"), "bytes");
    await symlink(repo, join(parent, "alias"));
    const { data, status } = await inventoryGitOwners({ ...options, maxEntries: "1" }, { mounts });
    expect(data.summary.commonStores).toBe(71);
    expect(data.summary.partialOwners).toBeGreaterThan(0);
    expect(status).toBe("degraded");
    expect(data.bounds.entriesObserved).toBe(1);
    expect(data.repoRoots[0]?.excluded).toBe(1);
    expect(
      data.repositories.find((r) => r.path === repo)?.packs?.pairs.packWithoutIndex,
    ).toBeNull();
    for (const bad of ["0", "-1", "1e6", "5000001"])
      await expect(inventoryGitOwners({ ...options, maxEntries: bad }, { mounts })).rejects.toThrow(
        "--max-entries",
      );
  });
});
