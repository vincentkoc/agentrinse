import { link, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inventoryStorage } from "../../src/commands/storage.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";

async function fixture() {
  const root = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-catalog-")));
  const home = join(root, "home"),
    systemRoot = join(root, "system");
  await mkdir(home);
  await mkdir(systemRoot);
  const deps = {
    platform: "darwin" as const,
    systemRoot,
    readMounts: async () => parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw"),
  };
  return { home, systemRoot, deps };
}

it("requires selection for credential caches and global system locations and keeps them opaque", async () => {
  const { home, systemRoot, deps } = await fixture();
  const credential = join(home, ".aws/cli/cache"),
    updates = join(systemRoot, "Library/Updates");
  for (const path of [credential, updates]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "private-material"), "ignored");
  }
  const normal = await inventoryStorage({ home }, deps);
  expect(normal.data.areas.some((area) => area.path === credential || area.path === updates)).toBe(
    false,
  );
  const explicit = await inventoryStorage(
    { home, rule: ["aws.cli-cache", "apple.system-updates"], measure: true },
    deps,
  );
  expect(explicit.data.areas).toHaveLength(2);
  for (const area of explicit.data.areas) {
    expect(area.coverage).toBe("stat-only");
    expect(area).not.toHaveProperty("fileBytes");
    expect(area).not.toHaveProperty("measurement");
  }
  expect(explicit.data.entriesInspected).toBe(0);
  expect(JSON.stringify(explicit)).not.toContain("private-material");
});

it("binds protected roots by rule and keeps project directories opaque across a symlink", async () => {
  const { home, deps } = await fixture();
  const project = join(home, "project"),
    saved = join(home, "saved=archive");
  await mkdir(join(project, "vendor"), { recursive: true });
  await mkdir(join(saved, ".experimental-vitest-cache"), { recursive: true });
  await symlink(saved, join(project, "node_modules"), "dir");
  const result = await inventoryStorage(
    { home, at: ["npm.rescue=" + saved], project: [project], measure: true },
    deps,
  );
  expect(result.data.areas.map((a) => [a.rule, a.coverage]).sort()).toEqual([
    ["npm.rescue", "stat-only"],
    ["project.unverified-transform", "linked"],
    ["project.vendor", "stat-only"],
  ]);
  expect(result.data.entriesInspected).toBe(0);
  const combined = await inventoryStorage(
    { home, at: ["npm.rescue=" + saved], system: true },
    deps,
  );
  expect(combined.data.areas.map((a) => a.rule)).toContain("apple.system-updates");
  expect(combined.data.areas.map((a) => a.rule)).toContain("npm.rescue");
  expect(combined.data.areas.map((a) => a.rule)).not.toContain("npm.content");
  await expect(inventoryStorage({ home, at: ["unknown=" + saved] }, deps)).rejects.toThrow("--at");
  await expect(inventoryStorage({ home, at: ["npm.rescue=" + home] }, deps)).rejects.toThrow(
    "specific",
  );
});

it("counts immediate Codex database metadata once per inode and leaves sessions and unrelated entries opaque", async () => {
  const { home, deps } = await fixture();
  const root = join(home, ".codex");
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "state_99.sqlite"), "abcd");
  await link(join(root, "state_99.sqlite"), join(root, "alias.db"));
  await writeFile(join(root, "state_99.sqlite-wal"), "xy");
  await writeFile(join(root, "sessions", "private.sqlite"), "private");
  await writeFile(join(root, "unrelated.log"), "private");
  const result = await inventoryStorage(
    { home, rule: ["codex.database-files"], measure: true },
    deps,
  );
  expect(result.data.areas[0]).toMatchObject({
    directExtent: "complete",
    fileBytes: { files: 2, logicalBytes: "6" },
  });
  expect(JSON.stringify(result)).not.toMatch(/state_99|private\.sqlite|unrelated\.log/);
  const limited = await inventoryStorage(
    { home, rule: ["codex.database-files"], maxEntries: "1" },
    deps,
  );
  expect(limited.data.areas[0]?.coverage).toBe("entry-limit");
});
