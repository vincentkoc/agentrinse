import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

import { describe, expect, it } from "vitest";

import { UnsafeAuditRootError, assertAuditRoot, isPathInside } from "../../src/core/safety.js";

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
