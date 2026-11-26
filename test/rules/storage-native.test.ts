import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { directStorageEntries } from "../../src/core/storage-observation.js";
import { measureCacheTree } from "../../src/core/storage-measurement.js";
import { collectPackStorage } from "../../src/rules/git/pack-storage.js";
import { collectCrabboxStorage } from "../../src/rules/openclaw/crabbox-storage.js";
import { inventoryStorage, executeStorageCommand } from "../../src/commands/storage.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";

const local = parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
const deps = { platform: "linux" as const, readMounts: async () => local };
async function fixture() {
  return realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-storage-native-")));
}
async function gitOwner(path: string) {
  const common = join(path, ".git"),
    pack = join(common, "objects", "pack");
  await mkdir(pack, { recursive: true });
  await writeFile(join(common, "HEAD"), "ref: refs/heads/main\n");
  return pack;
}
it("accounts pack names per durable owner and deduplicates global files and common directories", async () => {
  const home = await fixture(),
    a = join(home, "first repo"),
    b = join(home, "other"),
    x = await gitOwner(a),
    y = await gitOwner(b);
  const normal = "pack-" + "a".repeat(40);
  for (const name of [
    normal + ".pack",
    normal + ".idx",
    "tmp_pack_123",
    "tmp_idx_123",
    "tmp-other",
    "other",
  ])
    await writeFile(join(x, name), "ab");
  await link(join(x, normal + ".pack"), join(y, normal + ".pack"));
  await link(join(x, "tmp-other"), join(y, "renamed"));
  await symlink(join(x, "other"), join(x, "unknown-alias"));
  await mkdir(join(x, "nested"));
  const linked = join(home, "linked");
  await mkdir(linked);
  await writeFile(join(linked, ".git"), "gitdir: /private/unknown");
  const result = await inventoryStorage(
    { home, family: ["git"], repo: [a, join(a, ".git"), b, linked] },
    deps,
  );
  expect(result.data.gitPacks).toMatchObject({
    commonStores: 2,
    repeatedFiles: 2,
    ambiguousFiles: 1,
    uniqueDirectFiles: { files: 6, logicalBytes: "12" },
    byKind: {
      pack: { files: 1, logicalBytes: "2" },
      index: { files: 1 },
      "temporary-pack-name": { files: 1 },
      "temporary-index-name": { files: 1 },
      "ambiguous-identity": { files: 1 },
    },
    reclaimableBytes: null,
  });
  expect(result.data.gitPacks.repositories.map((r) => r.coverage)).toContain("duplicate-store");
  expect(result.data.gitPacks.repositories.map((r) => r.coverage)).toContain(
    "requires-durable-owner",
  );
  expect(result.data.gitPacks.repositories.find((r) => r.path === a)).toMatchObject({
    excluded: 1,
    directories: 1,
  });
  const limited = await inventoryStorage(
    { home, family: ["git"], repo: [a], maxEntries: "1" },
    deps,
  );
  expect(limited.status).toBe("degraded");
  const blocked = await inventoryStorage(
    { home, repo: [a], family: ["git"] },
    { readMounts: async () => [...local, { ...local[0]!, path: x }] },
  );
  expect(blocked.data.gitPacks.repositories[0]?.coverage).toBe("mount-boundary");
  for (const json of [true, false]) {
    const out = await executeStorageCommand({
      home: join(home, "synthetic home"),
      repo: [a],
      family: ["git"],
      redact: true,
      json,
    });
    expect(out).not.toContain(a);
    expect(out).not.toContain("first repo");
  }
});
async function capsule(root: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID(),
    path = join(root, "openclaw-crabbox-sync-" + id);
  await mkdir(path, { recursive: true });
  const stats = await lstat(path, { bigint: true }),
    identity = { dev: String(stats.dev), ino: String(stats.ino) };
  const file = join(path, "staging.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      id,
      kind: "capsule",
      ownerPid: 1234,
      rootIdentity: identity,
      payloadIdentity: identity,
      durable: true,
      repository: "/private/store",
      manifest: "b".repeat(64),
      users: "settled",
      state: "preserved",
      mirror: { key: "a".repeat(64), slotIdentity: identity, idle: true, lastUsed: 1000 },
      privateField: "secret marker",
      ...extra,
    }),
  );
  return { path, file };
}
it("matches only bounded same-owner receipts and keeps payload and controller contents opaque", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    healthy = await capsule(root, { leases: ["withheld-lease"] });
  await mkdir(join(healthy.path, "source", "protected"), { recursive: true });
  const held = await capsule(root, { hold: "writers" });
  const recovering = await capsule(root);
  await writeFile(join(recovering.path, "recovery.lock"), "");
  const noManifest = await capsule(root, { manifest: undefined });
  const mismatch = await capsule(root, { rootIdentity: { ino: "0", dev: "0" } });
  const linked = await capsule(root);
  await link(linked.file, join(home, "other-file"));
  const oversized = await capsule(root);
  await writeFile(oversized.file, "x".repeat(32769));
  const legacy = join(root, "openclaw-crabbox-sync-legacy");
  await mkdir(legacy);
  await mkdir(join(root, "mirrors"));
  await writeFile(join(root, "stray"), "secret");
  const report = await inventoryStorage({ home, family: ["crabbox"], crabboxRoot: [root] }, deps);
  const staging = report.data.crabbox[0]!;
  expect(staging).toMatchObject({
    coverage: "direct-complete",
    mirrorIndex: true,
    otherEntries: 1,
    reclaimableBytes: null,
  });
  const state = (path: string) => staging.entries.find((e) => e.path === path)?.classification;
  expect(state(healthy.path)).toBe("reported-reusable-mirror");
  expect(staging.entries.find((e) => e.path === healthy.path)).toMatchObject({
    recordedLeaseCount: 1,
    liveHolders: "unverified",
    lastUseReview: "at-least-48-hours",
  });
  expect(JSON.stringify(report)).not.toContain("withheld-lease");
  expect(report.status).toBe("degraded");
  expect(state(held.path)).toBe("reported-mirror");
  for (const entry of [recovering, noManifest]) expect(state(entry.path)).toBe("reported-mirror");
  for (const entry of [mismatch, linked, oversized])
    expect(state(entry.path)).toBe("unverified-staging");
  expect(state(legacy)).toBe("legacy-or-unidentified");
  expect(JSON.stringify(staging)).not.toContain("secret");
  expect(JSON.stringify(staging)).not.toContain("ownerPid");
  await expect(inventoryStorage({ home, crabboxRoot: [home] }, deps)).rejects.toThrow(
    "specific owner",
  );
  await expect(
    inventoryStorage({ home, crabboxRoot: [join(home, ".codex", "sessions")] }, deps),
  ).rejects.toThrow("Protected");
});

it("measures only explicitly requested verified staging metadata and reports protected contents as excluded", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    valid = await capsule(root);
  const source = join(valid.path, "source");
  await mkdir(join(source, ".git"), { recursive: true });
  await writeFile(join(source, ".git", "private"), "private");
  await writeFile(join(source, "code.ts"), "sample");
  const options = { home, crabboxRoot: [root], family: ["crabbox"] };
  const shallow = await inventoryStorage(options, deps);
  expect(shallow.data.crabbox[0]?.entries[0]).not.toHaveProperty("measurement");
  const measured = await inventoryStorage({ ...options, measure: true }, deps);
  const receiptBytes = (await lstat(valid.file)).size;
  expect(measured.data.crabbox[0]?.entries[0]).toMatchObject({
    measurement: {
      extent: "lower-bound",
      excluded: 1,
      fileBytes: { files: 2, logicalBytes: String(receiptBytes + 6) },
    },
  });
  expect(measured.data.crabbox[0]?.reclaimableBytes).toBeNull();
});

it("omits all observations of a hardlink that shrinks during a scan", async () => {
  const home = await fixture(),
    cache = join(home, "cache"),
    sub = join(cache, "nested");
  await mkdir(sub, { recursive: true });
  const blob = join(cache, "first");
  await writeFile(blob, "several bytes");
  await link(blob, join(sub, "second"));
  await link(blob, join(sub, "third"));
  const measure = await measureCacheTree(
    cache,
    await lstat(cache, { bigint: true }),
    local,
    { remaining: 20 },
    async (path, ...args) => {
      if (path === sub) await writeFile(blob, "x");
      return directStorageEntries(path, ...args);
    },
  );
  expect(measure).toMatchObject({
    extent: "lower-bound",
    reason: "changed",
    fileBytes: { files: 0, logicalBytes: "0", allocatedBytes: "0" },
  });
  const first = join(home, "repo-a"),
    second = join(home, "repo-b"),
    packA = await gitOwner(first),
    packB = await gitOwner(second);
  const file = join(packA, "tmp_pack_ab");
  await writeFile(file, "several bytes");
  await link(file, join(packB, "tmp_pack_ba"));
  const report = await collectPackStorage(
    [first, second],
    local,
    { remaining: 20 },
    async (path, ...args) => {
      if (path === packB) await writeFile(file, "");
      return directStorageEntries(path, ...args);
    },
  );
  expect(report).toMatchObject({
    changedFilesOmitted: 1,
    repeatedFiles: 1,
    ambiguousFiles: 1,
    uniqueDirectFiles: { files: 0, logicalBytes: "0", allocatedBytes: "0" },
  });
});
it("uses the receipt's millisecond clock for the 48-hour review boundary and excludes future timestamps", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    item = await capsule(root),
    lastUsed = 1000;
  const window = 48 * 60 * 60 * 1000;
  const observe = async (now: number) =>
    (
      await collectCrabboxStorage(root, local, { remaining: 20 }, now, { remaining: 10 })
    ).entries.find((e) => e.path === item.path);
  expect(await observe(lastUsed + window - 1)).toMatchObject({ lastUseReview: "under-48-hours" });
  expect(await observe(lastUsed + window)).toMatchObject({ lastUseReview: "at-least-48-hours" });
  const future = await observe(lastUsed - 1);
  expect(future).toMatchObject({ classification: "reported-mirror", lastUsedMs: null });
  expect(future).not.toHaveProperty("lastUseReview");
});
