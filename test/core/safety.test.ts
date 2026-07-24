import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

import { describe, expect, it } from "vitest";

import {
  UnsafeAuditRootError,
  UnsafeDestructiveFixtureError,
  assertAuditRoot,
  assertDestructiveFixtureRoot,
  isPathInside,
} from "../../src/core/safety.js";

describe("assertAuditRoot", () => {
  it("accepts an absolute synthetic root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-fixture-"));

    await expect(assertAuditRoot(root)).resolves.toBe(await realpath(root));
  });

  it("rejects the filesystem root", async () => {
    await expect(assertAuditRoot(parse(homedir()).root)).rejects.toBeInstanceOf(
      UnsafeAuditRootError,
    );
  });

  it("rejects a symlink alias to the filesystem root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentrinse-root-link-"));
    const link = join(parent, "root");
    await symlink(parse(parent).root, link, "dir");

    await expect(assertAuditRoot(link)).rejects.toBeInstanceOf(UnsafeAuditRootError);
  });

  it("accepts the real home", async () => {
    await expect(assertAuditRoot(homedir())).resolves.toBe(await realpath(homedir()));
  });

  it("rejects an ancestor of the real home", async () => {
    await expect(assertAuditRoot(dirname(homedir()))).rejects.toThrow(
      "ancestor of the real home directory",
    );
  });

  it("rejects relative paths", async () => {
    await expect(assertAuditRoot("./fixture")).rejects.toThrow("must be an absolute path");
  });
});

describe("isPathInside", () => {
  it("accepts a path at or below the root", () => {
    expect(isPathInside("/tmp/project", "/tmp/project")).toBe(true);
    expect(isPathInside("/tmp/project", "/tmp/project/node_modules")).toBe(true);
  });

  it("rejects sibling-prefix paths", () => {
    expect(isPathInside("/tmp/project", "/tmp/project-other")).toBe(false);
  });
});

describe("assertDestructiveFixtureRoot", () => {
  it("accepts a resolved child of the selected temporary root", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), "agentrinse-destructive-root-")),
    );
    const candidate = await realpath(
      await mkdtemp(join(temporaryRoot, "agentrinse-destructive-fixture-")),
    );
    const repositoryRoot = join(temporaryRoot, "repo");
    const realHome = join(temporaryRoot, "home");
    await mkdir(repositoryRoot);
    await mkdir(realHome);

    await expect(
      assertDestructiveFixtureRoot(candidate, {
        temporaryRoot,
        repositoryRoot,
        realHome,
      }),
    ).resolves.toBe(candidate);
  });

  it("rejects the temporary root, real home, repository overlap, and outside paths", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-destructive-parent-")));
    const temporaryRoot = join(parent, "temporary");
    const outside = join(parent, "outside");
    const repositoryRoot = join(temporaryRoot, "repo", "checkout");
    const repositoryParent = join(temporaryRoot, "repo");
    const repositoryChild = join(repositoryRoot, "fixture");
    const realHome = join(temporaryRoot, "home");
    await mkdir(repositoryChild, { recursive: true });
    await mkdir(realHome);
    await mkdir(outside);

    for (const candidate of [
      parse(parent).root,
      temporaryRoot,
      realHome,
      repositoryParent,
      repositoryChild,
      outside,
    ]) {
      await expect(
        assertDestructiveFixtureRoot(candidate, {
          temporaryRoot,
          repositoryRoot,
          realHome,
        }),
      ).rejects.toBeInstanceOf(UnsafeDestructiveFixtureError);
    }
  });

  it("rejects a symlink that resolves outside the selected temporary root", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-destructive-link-")));
    const temporaryRoot = join(parent, "temporary");
    const outside = join(parent, "outside");
    const link = join(temporaryRoot, "fixture-link");
    const repositoryRoot = join(temporaryRoot, "repo");
    const realHome = join(temporaryRoot, "home");
    await mkdir(temporaryRoot);
    await mkdir(outside);
    await mkdir(repositoryRoot);
    await mkdir(realHome);
    await symlink(outside, link);

    await expect(
      assertDestructiveFixtureRoot(link, {
        temporaryRoot,
        repositoryRoot,
        realHome,
      }),
    ).rejects.toBeInstanceOf(UnsafeDestructiveFixtureError);
  });
});
