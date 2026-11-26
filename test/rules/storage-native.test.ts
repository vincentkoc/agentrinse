import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
    healthy = await capsule(root);
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
