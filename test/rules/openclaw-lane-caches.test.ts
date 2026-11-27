import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inventoryStorage } from "../../src/commands/storage.js";
import { formatStorageReport } from "../../src/commands/storage-output.js";
import { storageRuleCatalog } from "../../src/commands/storage-rules.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { directoryMtimeReview, reviewAgeMs } from "../../src/rules/openclaw/lane-caches.js";
import { collectPrDependencies } from "../../src/rules/openclaw/pr-dependencies.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";

const local = parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
const deps = { readMounts: async () => local };
const fixture = async () =>
  realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-lane-cache-")));

it("withholds changing namespace evidence and reports a malformed v3 without entering it", async () => {
  const home = await fixture();
  const root = join(home, ".cache/openclaw/pr-dependencies");
  const v3 = join(root, "v3");
  await mkdir(root, { recursive: true });
  await writeFile(v3, "unexpected");
  const malformed = await collectPrDependencies(home, local, { remaining: 10 }, Date.now(), false);
  expect(malformed.namespaces[1]).toMatchObject({ coverage: "unexpected-kind", entries: [] });
  const donor = join(root, "a".repeat(64));
  await mkdir(donor);
  const changed = await collectPrDependencies(
    home,
    local,
    { remaining: 10 },
    Date.now(),
    true,
    async () => {
      await mkdir(join(root, "new-install"));
      return { extent: "complete" };
    },
  );
  expect(changed.namespaces).toEqual([
    { path: root, coverage: "changed", entries: [], otherEntries: 0, excluded: 0 },
  ]);
});

it("finds old Crabbox and PR staging and preserves an old donor used by a live lane", async () => {
  const home = await fixture();
  const root = join(home, ".cache/openclaw/pr-dependencies");
  const staging = join(home, ".cache/openclaw/crabbox-sync/openclaw-crabbox-sync-legacy");
  const donor = join(root, "v3", "a".repeat(64));
  const legacy = join(root, "install-42-abc");
  const recent = join(root, "v3", "install-12-abc");
  const unknown = join(root, "custom-private");
  const lock = join(root, "v3", ".metadata-lock");
  for (const path of [staging, donor, legacy, recent, unknown, lock])
    await mkdir(path, { recursive: true });
  const file = join(donor, "dependency");
  const laneLink = join(home, "live-lane-modules");
  await writeFile(file, "active");
  await symlink(donor, laneLink);
  await writeFile(join(root, "v3", "lifetime.sqlite"), "opaque ledger fixture");
  const old = new Date(Date.now() - reviewAgeMs - 60_000);
  for (const path of [donor, legacy, staging]) await utimes(path, old, old);
  const held = await open(join(laneLink, "dependency"), "r");
  try {
    const { data, status } = await inventoryStorage(
      { home, family: ["openclaw"], measure: true },
      deps,
    );
    expect(data.crabbox[0]?.entries[0]).toMatchObject({
      path: staging,
      directoryMtimeReview: "older-than-48-hours",
    });
    const pr = data.prDependencies!;
    expect(pr).toMatchObject({ liveHolders: "unverified", reclaimableBytes: null });
    const [outer, v3] = pr.namespaces;
    expect(outer?.entries).toContainEqual(
      expect.objectContaining({ path: legacy, directoryMtimeReview: "older-than-48-hours" }),
    );
    expect(outer?.entries.find((e) => e.path === unknown)).not.toHaveProperty("measurement");
    expect(v3?.entries).toContainEqual(
      expect.objectContaining({
        path: donor,
        kind: "installation",
        directoryMtimeReview: "older-than-48-hours",
        measurement: expect.objectContaining({
          fileBytes: expect.objectContaining({ logicalBytes: "6" }),
        }),
      }),
    );
    expect(v3?.entries).toContainEqual(
      expect.objectContaining({ path: recent, directoryMtimeReview: "within-48-hours" }),
    );
    expect(v3?.otherEntries).toBe(2);
    expect(formatStorageReport(data, status)).toContain("live lane holds unverified");
    expect(await held.readFile("utf8")).toBe("active");
    expect(await realpath(laneLink)).toBe(donor);
    expect(await readFile(join(root, "v3", "lifetime.sqlite"), "utf8")).toBe(
      "opaque ledger fixture",
    );
  } finally {
    await held.close();
  }
});

it("discovers both cache rules by default, allows independent selection and withholds linked namespaces", async () => {
  const home = await fixture();
  const root = join(home, ".cache/openclaw/pr-dependencies");
  const rule = ["openclaw.pr-dependencies"];
  const plain = await inventoryStorage({ home }, deps);
  expect(plain.data.crabbox).toHaveLength(1);
  expect(plain.data.prDependencies?.namespaces[0]).toMatchObject({
    path: root,
    coverage: "missing",
  });
  expect(storageRuleCatalog().ownerEvidence.map((e) => e.id)).toEqual(
    expect.arrayContaining([...rule, "crabbox.staging"]),
  );
  await mkdir(root, { recursive: true });
  await symlink(home, join(root, "v3"));
  const linked = await inventoryStorage({ home, rule }, deps);
  expect(linked.status).toBe("degraded");
  expect(linked.data.prDependencies?.namespaces).toHaveLength(1);
  expect(linked.data.prDependencies?.namespaces[0]).toMatchObject({ entries: [], excluded: 1 });
  expect(linked.data.crabbox).toEqual([]);
  const crabboxOnly = await inventoryStorage({ home, rule: ["crabbox.staging"] }, deps);
  expect(crabboxOnly.data.crabbox).toHaveLength(1);
  expect(crabboxOnly.data.prDependencies).toBeUndefined();
});

it("preserves the strict 48-hour boundary and reports future timestamps and incomplete scans", async () => {
  const home = await fixture();
  const root = join(home, ".cache/openclaw/pr-dependencies");
  await mkdir(join(root, "legacy"), { recursive: true });
  await mkdir(join(root, "another"));
  const now = Math.floor(Date.now() / 1000) * 1000;
  await utimes(root, now / 1000, (now - reviewAgeMs) / 1000);
  const stats = await lstat(root, { bigint: true });
  expect(directoryMtimeReview(stats, now)).toBe("within-48-hours");
  expect(directoryMtimeReview(stats, now + 1)).toBe("older-than-48-hours");
  expect(directoryMtimeReview(stats, now - reviewAgeMs - 1)).toBe("unknown");
  const limited = await inventoryStorage(
    { home, rule: ["openclaw.pr-dependencies"], maxEntries: "1" },
    deps,
  );
  expect(limited).toMatchObject({
    status: "degraded",
    data: { prDependencies: { namespaces: [{ coverage: "entry-limit" }] } },
  });
});
