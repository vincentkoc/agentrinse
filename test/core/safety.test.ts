import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { UnsafeAuditRootError, assertAuditRoot, isPathInside } from "../../src/core/safety.js";

describe("assertAuditRoot", () => {
  it("accepts an absolute synthetic root", () => {
    const root = join(tmpdir(), "agentrinse-fixture");

    expect(assertAuditRoot(root)).toBe(root);
  });

  it("rejects the filesystem root", () => {
    expect(() => assertAuditRoot("/")).toThrow(UnsafeAuditRootError);
  });

  it("accepts the real home", () => {
    expect(assertAuditRoot(homedir())).toBe(homedir());
  });

  it("rejects an ancestor of the real home", () => {
    expect(() => assertAuditRoot(dirname(homedir()))).toThrow(
      "ancestor of the real home directory",
    );
  });

  it("rejects relative paths", () => {
    expect(() => assertAuditRoot("./fixture")).toThrow("must be an absolute path");
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
