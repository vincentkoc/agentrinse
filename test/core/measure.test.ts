import { once } from "node:events";
import { opendir, lstat, mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { describe, expect, it } from "vitest";

import { DirectoryChangeProof } from "../../src/core/directory-change-proof.js";
import { measurePath } from "../../src/core/measure.js";

describe("measurePath", () => {
  it("prunes protected entries before inspecting files, links or directories", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    await mkdir(join(root, "nested", ".codex"), { recursive: true });
    await writeFile(join(root, "nested", ".codex", "history.jsonl"), "preserve");
    const result = await measurePath(
      root,
      { maxEntries: 10, protectEntry: (name) => name === ".codex" },
      {
        inspect: async (path) => {
          expect(path).not.toContain(".codex");
          return lstat(path);
        },
      },
    );
    expect(result).toMatchObject({ protectedEntries: 1, bytes: 0, entries: 3 });
    expect((await measurePath(root, { maxEntries: 10 })).bytes).toBe(8);
  });

  it("refuses incomplete directory proof and detects a change during enumeration", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const proof = new DirectoryChangeProof();
    expect(proof.unchanged(root)).toBe(false);
    await expect(
      measurePath(
        root,
        { maxEntries: 10, directoryProof: proof },
        {
          openDirectory: async (path) => {
            const reader = await opendir(path);
            await mkdir(join(path, "new-child"));
            return reader;
          },
        },
      ),
    ).rejects.toThrow("changed during enumeration");
    expect(proof.unchanged(root)).toBe(false);
  });

  it("measures regular files recursively", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "a.txt"), "abc");
    await writeFile(join(root, "nested", "b.txt"), "12345");

    const result = await measurePath(root, { maxEntries: 100 });

    expect(result.bytes).toBe(8);
    expect(result.symlinksSkipped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.newestMtimeMs).toBeGreaterThan(0);
  });

  it("does not follow symlinks", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const outside = createFixtureDirectory(join(tmpdir(), "agentrinse-outside-"));
    await writeFile(join(outside, "secret.txt"), "do not count");
    await symlink(outside, join(root, "outside"));

    const result = await measurePath(root, { maxEntries: 100 });

    expect(result.bytes).toBe(0);
    expect(result.symlinksSkipped).toBe(1);
  });

  it("stops at the entry budget", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");

    const result = await measurePath(root, { maxEntries: 1 });

    expect(result.entries).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("bounds lazy enumeration without materializing a large tree", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const template = join(root, "template");
    await writeFile(template, "x");
    const rootStats = await lstat(root);
    const fileStats = await lstat(template);
    let yielded = 0;
    let closed = false;

    const result = await measurePath(
      root,
      { maxEntries: 4 },
      {
        inspect: async (path) => (path === root ? rootStats : fileStats),
        openDirectory: async () => ({
          async close() {
            closed = true;
          },
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < 1_000_000; index += 1) {
              yielded += 1;
              yield { name: `entry-${String(index)}` };
            }
          },
        }),
      },
    );

    expect(result.entries).toBe(4);
    expect(result.truncated).toBe(true);
    expect(yielded).toBe(4);
    expect(closed).toBe(true);
  });

  it("charges excluded names against the enumeration budget", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const rootStats = await lstat(root);
    let yielded = 0;
    let closed = false;

    const result = await measurePath(
      root,
      {
        maxEntries: 4,
        excludeRootEntries: ["ignored"],
      },
      {
        inspect: async () => rootStats,
        openDirectory: async () => ({
          async close() {
            closed = true;
          },
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < 1_000_000; index += 1) {
              yielded += 1;
              yield { name: "ignored" };
            }
          },
        }),
      },
    );

    expect(result.entries).toBe(1);
    expect(result.truncated).toBe(true);
    expect(yielded).toBe(4);
    expect(closed).toBe(true);
  });

  it("closes directory iteration when cancellation arrives", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const rootStats = await lstat(root);
    const controller = new AbortController();
    let yielded = 0;
    let closed = false;

    await expect(
      measurePath(
        root,
        { maxEntries: 100, signal: controller.signal },
        {
          inspect: async () => rootStats,
          openDirectory: async () => ({
            async close() {
              closed = true;
            },
            async *[Symbol.asyncIterator]() {
              for (let index = 0; index < 1_000_000; index += 1) {
                yielded += 1;
                if (yielded === 3) {
                  controller.abort(new Error("synthetic cancellation"));
                }
                yield { name: `entry-${String(index)}` };
              }
            },
          }),
        },
      ),
    ).rejects.toThrow("synthetic cancellation");

    expect(yielded).toBe(3);
    expect(closed).toBe(true);
  });

  it("reports Unix sockets as unsupported special entries", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const socketPath = join(root, "active.sock");
    const server = createServer();
    server.listen(socketPath);
    await once(server, "listening");

    try {
      const result = await measurePath(root, { maxEntries: 100 });

      expect(result.specialEntries).toBe(1);
      expect(result.bytes).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("changes the fingerprint for same-size in-place writes", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    const path = join(root, "cache.bin");
    await writeFile(path, "before");
    const original = await stat(path);
    const before = await measurePath(root, { maxEntries: 100 });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path, "change");
    await utimes(path, original.atime, original.mtime);
    const after = await measurePath(root, { maxEntries: 100 });

    expect(after.bytes).toBe(before.bytes);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.mountBoundaries).toBe(0);
  });

  it("counts nested VCS metadata without descending into it", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-vcs-"));
    await writeFile(join(root, "keep.txt"), "x");
    const gitDir = join(root, ".git");
    await mkdir(gitDir);
    // Enough nested files that descending would exhaust a tight entry budget.
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(gitDir, `object-${index}`), `blob-${index}`);
    }

    const result = await measurePath(root, { maxEntries: 5 });

    expect(result.vcsMetadataEntries).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(1);
  });

  it("can exclude a Git-owned root control entry", async () => {
    const root = createFixtureDirectory(join(tmpdir(), "agentrinse-measure-"));
    await writeFile(join(root, "data.txt"), "keep");
    await writeFile(join(root, ".git"), "gitdir: /tmp/one\n");
    const before = await measurePath(root, {
      maxEntries: 100,
      excludeRootEntries: [".git"],
    });
    await writeFile(join(root, ".git"), "gitdir: /tmp/two\n");
    const after = await measurePath(root, {
      maxEntries: 100,
      excludeRootEntries: [".git"],
    });

    expect(after).toEqual(before);
  });
});
