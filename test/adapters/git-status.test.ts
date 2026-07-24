import { describe, expect, it } from "vitest";

import { parseGitStatusPorcelainV2 } from "../../src/adapters/git/status.js";

describe("parseGitStatusPorcelainV2", () => {
  it("collects branch, push, staged, modified, untracked, and conflict facts", () => {
    const input = [
      "# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "# branch.head task",
      "# branch.upstream origin/task",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 a a staged.ts",
      "1 .M N... 100644 100644 100644 a a modified.ts",
      "2 MM N... 100644 100644 100644 a a R100 renamed.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 a a a conflict.ts",
      "? untracked.ts",
      "! ignored.log",
      "",
    ].join("\0");

    expect(parseGitStatusPorcelainV2(input)).toEqual({
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "task",
      upstream: "origin/task",
      ahead: 2,
      behind: 1,
      staged: 3,
      modified: 3,
      untracked: 1,
      conflicted: 1,
      ignored: 1,
    });
  });

  it("handles detached and unborn heads", () => {
    expect(
      parseGitStatusPorcelainV2(
        ["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0"),
      ),
    ).toEqual({
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      ignored: 0,
    });
  });

  it("fails closed on unknown records", () => {
    expect(() => parseGitStatusPorcelainV2("future record\0")).toThrow(
      "unknown porcelain v2 record",
    );
  });
});
