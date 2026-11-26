import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { directStorageEntries } from "../../src/core/storage-observation.js";
import { measureCacheTree } from "../../src/core/storage-measurement.js";
import { collectPackStorage } from "../../src/rules/git/pack-storage.js";
import { currentStagingIdentity } from "../../src/rules/openclaw/crabbox-identity.js";
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
  const payload = join(path, "payload");
  await mkdir(payload, { recursive: true });
  async function identityOf(directory: string) {
    const stats = await lstat(directory, { bigint: true });
    return {
      dev: String(stats.dev),
      ino: String(stats.ino),
      ...(stats.birthtimeNs > 0n
        ? {
            stable: {
              path: directory,
              birthtimeNs: String(stats.birthtimeNs),
              volume: "device:" + stats.dev,
            },
          }
        : {}),
    };
  }
  const identity = await identityOf(path),
    payloadIdentity = await identityOf(payload);
  const file = join(path, "staging.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      id,
      kind: "capsule",
      ownerPid: 1234,
      rootIdentity: identity,
      payloadIdentity,
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
  await mkdir(join(healthy.path, "payload", "source", "protected"), { recursive: true });
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
    coverage: "direct-partial",
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
  const source = join(valid.path, "payload", "source");
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

it("withholds receipt age and bytes for relocated staging and replacement payloads", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    item = await capsule(root),
    moved = join(home, "moved");
  await rename(root, moved);
  const scan = (dir: string) =>
    collectCrabboxStorage(dir, local, { remaining: 100 }, Date.now(), { remaining: 10 }, true);
  const relocated = (await scan(moved)).entries[0]!;
  expect(relocated).toMatchObject({
    classification: "unverified-staging",
    measurement: { extent: "unknown" },
  });
  expect(relocated).not.toHaveProperty("lastUseReview");
  await rename(moved, root);
  const payload = join(item.path, "payload");
  await rename(payload, join(home, "previous"));
  await mkdir(payload);
  const replacement = (await scan(root)).entries[0]!;
  expect(replacement).toMatchObject({
    classification: "unverified-staging",
    measurement: { extent: "unknown" },
  });
  expect(replacement.measurement).not.toHaveProperty("fileBytes");
});
it("discards collected bytes if the bound payload changes while measurement is running", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    item = await capsule(root);
  const measured = await collectCrabboxStorage(
    root,
    local,
    { remaining: 100 },
    Date.now(),
    { remaining: 10 },
    true,
    async (...args) => {
      const result = await measureCacheTree(...args);
      await rename(join(item.path, "payload"), join(home, "original"));
      await mkdir(join(item.path, "payload"));
      return result;
    },
  );
  expect(measured.entries[0]).toMatchObject({
    classification: "unverified-staging",
    receipt: "changed-during-measurement",
    measurement: { extent: "unknown" },
  });
  expect(measured.entries[0]?.measurement).not.toHaveProperty("fileBytes");
});
it("reports withheld staging entries when the only child is linked or mounted", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    other = join(home, "other");
  await mkdir(root);
  await mkdir(other);
  const path = join(root, "openclaw-crabbox-sync-" + randomUUID());
  await symlink(other, path);
  const opts = { home, crabboxRoot: [root], family: ["crabbox"] };
  const linked = await inventoryStorage(opts, deps);
  expect(linked).toMatchObject({
    status: "degraded",
    data: { crabbox: [{ coverage: "direct-partial", excluded: 1, entries: [] }] },
  });
  expect(await executeStorageCommand(opts)).toContain("withheld entries: 1");
  await unlink(path);
  await mkdir(path);
  const mounted = await inventoryStorage(opts, {
    readMounts: async () => [...local, { ...local[0]!, path }],
  });
  expect(mounted).toMatchObject({
    status: "degraded",
    data: { crabbox: [{ coverage: "direct-partial", excluded: 1, entries: [] }] },
  });
});

it("requires the receipt's stable volume and birth time even on the same current device", async () => {
  const home = await fixture(),
    root = join(home, "staging"),
    item = await capsule(root),
    payload = join(item.path, "payload");
  const uuid = "uuid:" + randomUUID(),
    stats = await lstat(item.path, { bigint: true }),
    child = await lstat(payload, { bigint: true });
  const rootIdentity = {
    dev: String(stats.dev),
    ino: String(stats.ino),
    stable: { path: item.path, birthtimeNs: String(stats.birthtimeNs), volume: uuid },
  };
  const payloadIdentity = {
    dev: String(child.dev),
    ino: String(child.ino),
    stable: { path: payload, birthtimeNs: String(child.birthtimeNs), volume: uuid },
  };
  const entry = { path: item.path, name: "unused", stats },
    owner = { rootIdentity, payloadIdentity };
  expect(await currentStagingIdentity(entry, owner, local, 0n, async () => uuid)).toBe(true);
  expect(await currentStagingIdentity(entry, owner, local, 0n, async () => undefined)).toBe(false);
  expect(
    await currentStagingIdentity(entry, owner, local, 0n, async () => "uuid:" + randomUUID()),
  ).toBe(false);
  rootIdentity.stable.birthtimeNs = String(stats.birthtimeNs + 1n);
  expect(await currentStagingIdentity(entry, owner, local, 0n, async () => uuid)).toBe(false);
});
