import { describe, expect, it } from "vitest";

import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";

describe("parseWorktreePorcelain", () => {
  it("parses branch and detached records", () => {
    const input = [
      "worktree /tmp/main",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /tmp/task",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "locked agent active",
      "",
    ].join("\0");

    expect(parseWorktreePorcelain(input)).toEqual([
      {
        path: "/tmp/main",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "refs/heads/main",
        detached: false,
        bare: false,
      },
      {
        path: "/tmp/task",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        detached: true,
        bare: false,
        locked: "agent active",
      },
    ]);
  });

  it("rejects fields before the first worktree", () => {
    expect(() => parseWorktreePorcelain("HEAD abc\0")).toThrow("field before record");
  });
});
