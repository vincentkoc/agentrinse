import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  UnsafeAuditRootError,
  assertSyntheticAuditRoot,
  isPathInside,
} from "../../src/core/safety.js";

describe("assertSyntheticAuditRoot", () => {
  it("accepts an absolute synthetic root", () => {
    const root = join(tmpdir(), "agentrinse-fixture");

    expect(assertSyntheticAuditRoot(root)).toBe(root);
  });

  it("rejects the filesystem root", () => {
    expect(() => assertSyntheticAuditRoot("/")).toThrow(UnsafeAuditRootError);
  });

  it("rejects the real home", () => {
    expect(() => assertSyntheticAuditRoot(homedir())).toThrow(
      "pre-alpha builds refuse to audit the real home directory",
    );
  });

  it("rejects an ancestor of the real home", () => {
    expect(() => assertSyntheticAuditRoot(dirname(homedir()))).toThrow(
      "ancestor of the real home directory",
    );
  });

  it("rejects relative paths", () => {
    expect(() => assertSyntheticAuditRoot("./fixture")).toThrow("must be an absolute path");
  });
});

describe("isPathInside", () => {
  it("accepts a path at or below the root", () => {
    expect(isPathInside("/tmp/project", "/tmp/project")).toBe(true);
    expect(isPathInside("/tmp/project", "/tmp/project/node_modules")).toBe(
      true,
    );
  });

  it("rejects sibling-prefix paths", () => {
    expect(isPathInside("/tmp/project", "/tmp/project-other")).toBe(false);
  });
});
