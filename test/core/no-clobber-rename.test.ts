import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exchangePaths, renameNoReplace } from "../../src/core/no-clobber-rename.js";

describe("renameNoReplace", () => {
  it("moves a directory only when the destination is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-no-clobber-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await writeFile(join(source, "source.txt"), "source\n");

    await renameNoReplace(source, destination);

    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(destination, "source.txt"), "utf8")).resolves.toBe("source\n");
  });

  it("never replaces an occupied destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-no-clobber-"));
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
    const root = await mkdtemp(join(tmpdir(), "agentrinse-exchange-"));
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "source\n");
    await writeFile(destination, "destination\n");

    await exchangePaths(source, destination);

    await expect(readFile(source, "utf8")).resolves.toBe("destination\n");
    await expect(readFile(destination, "utf8")).resolves.toBe("source\n");
  });
});
