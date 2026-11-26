import { mkdir, realpath, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { inventoryStorage, executeStorageCommand } from "../../src/commands/storage.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { observeStoragePath } from "../../src/core/storage-observation.js";

const local = parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
async function fixture() {
  return realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-storage-")));
}

it("accounts only direct regular files and leaves protected state opaque", async () => {
  const home = await fixture(),
    graphs = join(home, ".cache/codebase-memory-mcp"),
    retained = join(home, ".codex/artifacts");
  await mkdir(join(graphs, "nested"), { recursive: true });
  await mkdir(retained, { recursive: true });
  await writeFile(join(graphs, "example.db"), Buffer.from([0xfe, 0xff]));
  await writeFile(join(graphs, "nested", "private"), "ignore me");
  await symlink(retained, join(graphs, "linked"));
  await writeFile(join(retained, "transcript.jsonl"), "protected");
  const result = await inventoryStorage(
    { home },
    { platform: "linux", readMounts: async () => local },
  );
  expect(result.data.areas.find((a) => a.rule === "codebase-memory.graphs")).toMatchObject({
    coverage: "direct-complete",
    directDirectories: 1,
    excluded: 1,
    fileBytes: { files: 1, logicalBytes: "2" },
  });
  const state = result.data.areas.find((a) => a.rule === "codex.artifacts");
  expect(state).toMatchObject({ coverage: "stat-only" });
  expect(state).not.toHaveProperty("fileBytes");
  expect(JSON.stringify(result)).not.toContain("transcript.jsonl");
});
it("distinguishes uninspected direct caches, an empty cache, and a partially counted cache", async () => {
  const home = await fixture();
  const content = join(home, ".npm/_cacache");
  const execCache = join(home, ".npm/_npx");
  await mkdir(content, { recursive: true });
  await mkdir(execCache);
  await writeFile(join(content, "one"), "a");
  await writeFile(join(execCache, "two"), "bb");
  const options = { home, rule: ["npm.content", "npm.exec"], maxEntries: "1" };
  const deps = { platform: "linux" as const, readMounts: async () => local };
  const first = await inventoryStorage(options, deps);
  const unknown = first.data.areas.find((area) => area.rule === "npm.exec");
  expect(unknown).toMatchObject({ coverage: "entry-limit", directExtent: "unknown" });
  expect(unknown).not.toHaveProperty("fileBytes");
  expect(unknown).not.toHaveProperty("directDirectories");
  expect(await executeStorageCommand(options)).toContain("direct bytes unknown");
  await writeFile(join(content, "three"), "c");
  const partial = (await inventoryStorage(options, deps)).data.areas[0];
  expect(partial).toMatchObject({
    coverage: "entry-limit",
    directExtent: "lower-bound",
    fileBytes: { files: 1, logicalBytes: "1" },
  });
  const emptyHome = await fixture();
  await mkdir(join(emptyHome, ".npm/_cacache"), { recursive: true });
  const empty = (await inventoryStorage({ ...options, home: emptyHome }, deps)).data.areas[0];
  expect(empty).toMatchObject({
    directExtent: "complete",
    directDirectories: 0,
    excluded: 0,
    fileBytes: { files: 0, logicalBytes: "0", allocatedBytes: "0" },
  });
});
it("withholds network and unknown mounts before any metadata syscall", async () => {
  const home = await fixture();
  const mounts = [
    ...local,
    { ...local[0]!, path: home, access: "network" as const, filesystem: "afpfs" },
  ];
  await expect(
    observeStoragePath(join(home, "any"), mounts, async () => {
      throw new Error("unexpected stat");
    }),
  ).resolves.toEqual({ status: "mount-boundary" });
  const result = await inventoryStorage(
    { home, volume: [home], family: ["mounts"] },
    { readMounts: async () => mounts },
  );
  expect(result.data.areas).toEqual([]);
  expect(result.data.volumeEvidence[0]?.coveringMount?.filesystem).toBe("afpfs");
  expect((await inventoryStorage({ home }, { readMounts: async () => undefined })).status).toBe(
    "degraded",
  );
});
it("labels incomplete budgets, linked roots and redacts paths in both formats", async () => {
  const home = await fixture(),
    graph = join(home, ".cache/codebase-memory-mcp");
  await mkdir(graph, { recursive: true });
  await writeFile(join(graph, "a"), "a");
  await writeFile(join(graph, "b"), "b");
  await symlink(graph, join(home, ".cache/uv"));
  const result = await inventoryStorage(
    { home, maxEntries: "1" },
    { platform: "linux", readMounts: async () => local },
  );
  expect(result.status).toBe("degraded");
  expect(result.data.entriesInspected).toBe(1);
  expect(result.data.areas.find((a) => a.rule === "uv.cache")?.coverage).toBe("linked");
  expect(result.data.areas.find((a) => a.rule === "codebase-memory.graphs")?.coverage).toBe(
    "entry-limit",
  );
  for (const json of [true, false])
    expect(
      await executeStorageCommand({
        home,
        retainedRoot: [graph],
        family: ["retained"],
        json,
        redact: true,
      }),
    ).not.toContain(home);
});

it("measures only selected cache leaves and reports excluded history, aliases, mounts and limits", async () => {
  const home = await fixture(),
    cache = join(home, ".npm/_cacache"),
    nested = join(cache, "content", "ab");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "data"), "12345");
  const opts = { home, family: ["developer"], rule: ["npm.content"], measure: true };
  const deps = { platform: "linux" as const, readMounts: async () => local };
  expect((await inventoryStorage(opts, deps)).data.areas[0]).toMatchObject({
    coverage: "tree-complete",
    measurement: { extent: "complete", fileBytes: { files: 1, logicalBytes: "5" } },
  });
  await mkdir(join(nested, ".openclaw-dev"));
  await writeFile(join(nested, ".openclaw-dev", "history"), "secret");
  await mkdir(join(nested, "shared"));
  await writeFile(join(nested, "shared", "outside"), "outside");
  await symlink(nested, join(cache, "alias"));
  const mounts = [...local, { ...local[0]!, path: join(nested, "shared") }];
  const result = await inventoryStorage(opts, { readMounts: async () => mounts });
  expect(result.status).toBe("degraded");
  expect(result.data.areas[0]).toMatchObject({
    measurement: { extent: "lower-bound", excluded: 3, fileBytes: { files: 1, logicalBytes: "5" } },
  });
  const limited = await inventoryStorage({ ...opts, maxEntries: "1" }, deps);
  expect(limited.data.entriesInspected).toBe(1);
  expect(limited.data.areas[0]?.measurement?.extent).toBe("lower-bound");
  const outside = await inventoryStorage(opts, {
    readMounts: async () => [...local, { ...local[0]!, path: cache, access: "network" }],
  });
  expect(outside.data.areas[0]).toMatchObject({
    coverage: "mount-boundary",
    measurement: { extent: "unknown" },
  });
  const retained = join(home, ".codex", "artifacts");
  await mkdir(retained, { recursive: true });
  const state = await inventoryStorage({ home, rule: ["codex.artifacts"], measure: true }, deps);
  expect(state.data.areas[0]).toMatchObject({ coverage: "stat-only" });
  expect(state.data.areas[0]).not.toHaveProperty("measurement");
  await expect(inventoryStorage({ home, rule: ["../other"], measure: true }, deps)).rejects.toThrow(
    "Unknown storage rule",
  );
});
