import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exchangePaths,
  renameAtNoReplace,
  renameNoReplace,
} from "../../src/core/no-clobber-rename.js";

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("renameNoReplace", () => {
  it("moves a directory only when the destination is absent", async () => {
    const root = await tempRoot("agentrinse-no-clobber-");
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await writeFile(join(source, "source.txt"), "source\n");

    await renameNoReplace(source, destination);

    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(destination, "source.txt"), "utf8")).resolves.toBe("source\n");
  });

  it("never replaces an occupied destination", async () => {
    const root = await tempRoot("agentrinse-no-clobber-");
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(source, "source.txt"), "source\n");
    await writeFile(join(destination, "destination.txt"), "destination\n");

    await expect(renameNoReplace(source, destination)).rejects.toMatchObject({ code: "EEXIST" });

    await expect(readFile(join(source, "source.txt"), "utf8")).resolves.toBe("source\n");
    await expect(readFile(join(destination, "destination.txt"), "utf8")).resolves.toBe(
      "destination\n",
    );
  });

  it("atomically exchanges two occupied paths", async () => {
    const root = await tempRoot("agentrinse-exchange-");
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "source\n");
    await writeFile(destination, "destination\n");

    await exchangePaths(source, destination);

    await expect(readFile(source, "utf8")).resolves.toBe("destination\n");
    await expect(readFile(destination, "utf8")).resolves.toBe("source\n");
  });

  it("reports a missing source as a rename errno error with both paths", async () => {
    const root = await tempRoot("agentrinse-no-clobber-");
    const source = join(root, "missing");
    const destination = join(root, "destination");

    await expect(renameNoReplace(source, destination)).rejects.toMatchObject({
      code: "ENOENT",
      errno: expect.any(Number),
      path: source,
      dest: destination,
      syscall: "rename",
      message: `atomic no-replace rename failed from ${source} to ${destination}: ENOENT`,
    });
  });
});

describe("renameAtNoReplace", () => {
  async function openDirectory(path: string) {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  }

  it.runIf(["darwin", "linux"].includes(process.platform))(
    "moves an entry between directory descriptors without replacing",
    async () => {
      const root = await tempRoot("agentrinse-rename-at-");
      const from = join(root, "from");
      const to = join(root, "to");
      await mkdir(from);
      await mkdir(to);
      await writeFile(join(from, "entry.txt"), "entry\n");
      await writeFile(join(to, "occupied.txt"), "occupied\n");
      const fromDirectory = await openDirectory(from);
      const toDirectory = await openDirectory(to);
      try {
        await expect(
          renameAtNoReplace(fromDirectory.fd, "entry.txt", toDirectory.fd, "occupied.txt"),
        ).rejects.toMatchObject({ code: "EEXIST", path: "entry.txt", dest: "occupied.txt" });
        await expect(readFile(join(to, "occupied.txt"), "utf8")).resolves.toBe("occupied\n");

        await renameAtNoReplace(fromDirectory.fd, "entry.txt", toDirectory.fd, "moved.txt");
      } finally {
        await fromDirectory.close();
        await toDirectory.close();
      }

      await expect(access(join(from, "entry.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(to, "moved.txt"), "utf8")).resolves.toBe("entry\n");
    },
  );
});

describe("exchangePaths", () => {
  it("refuses to exchange with a missing destination", async () => {
    const root = await tempRoot("agentrinse-exchange-");
    const source = join(root, "source.txt");
    const destination = join(root, "missing.txt");
    await writeFile(source, "source\n");

    await expect(exchangePaths(source, destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(source, "utf8")).resolves.toBe("source\n");
  });
});

describe("unsupported platforms", () => {
  it.each([
    ["renameNoReplace", () => renameNoReplace("/a", "/b", "win32"), "atomic no-replace rename"],
    ["exchangePaths", () => exchangePaths("/a", "/b", "win32"), "atomic path exchange"],
    [
      "renameAtNoReplace",
      () => renameAtNoReplace(3, "a", 4, "b", "win32"),
      "atomic fd-relative no-replace rename",
    ],
  ])("%s fails closed with ENOTSUP, including on repeat calls", async (_name, call, message) => {
    await expect(call()).rejects.toMatchObject({
      code: "ENOTSUP",
      message: `${message} is unsupported on win32`,
    });
    await expect(call()).rejects.toMatchObject({ code: "ENOTSUP" });
  });
});
