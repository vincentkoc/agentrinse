import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measurePath } from "../../src/core/measure.js";

describe("measurePath", () => {
  it("measures regular files recursively", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-measure-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "a.txt"), "abc");
    await writeFile(join(root, "nested", "b.txt"), "12345");

    const result = await measurePath(root, { maxEntries: 100 });

    expect(result.bytes).toBe(8);
    expect(result.symlinksSkipped).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("does not follow symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-measure-"));
    const outside = await mkdtemp(join(tmpdir(), "agentrinse-outside-"));
    await writeFile(join(outside, "secret.txt"), "do not count");
    await symlink(outside, join(root, "outside"));

    const result = await measurePath(root, { maxEntries: 100 });

    expect(result.bytes).toBe(0);
    expect(result.symlinksSkipped).toBe(1);
  });

  it("stops at the entry budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-measure-"));
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");

    const result = await measurePath(root, { maxEntries: 1 });

    expect(result.entries).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
