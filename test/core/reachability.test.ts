import { describe, expect, it } from "vitest";

import { ReachabilityIndex } from "../../src/core/reachability.js";

describe("ReachabilityIndex", () => {
  it("adds roots monotonically and explains matching worktrees deterministically", () => {
    const index = new ReachabilityIndex();
    index.add({
      code: "recent-session",
      source: "claude",
      path: "/tmp/repo/worktree",
      detail: "Claude remembers this project.",
      evidenceRef: "claude:project",
    });
    index.add({
      code: "active-session",
      source: "codex",
      path: "/tmp/repo/worktree/src",
      detail: "Codex links a thread to this path.",
      evidenceRef: "codex:thread",
    });

    expect(index.rootsFor("/tmp/repo/worktree", "2026-07-24T00:00:00.000Z")).toEqual([
      {
        code: "active-session",
        source: "codex",
        observedAt: "2026-07-24T00:00:00.000Z",
        detail: "Codex links a thread to this path.",
        evidenceRef: "codex:thread",
      },
      {
        code: "recent-session",
        source: "claude",
        observedAt: "2026-07-24T00:00:00.000Z",
        detail: "Claude remembers this project.",
        evidenceRef: "claude:project",
      },
    ]);
    expect(index.rootsFor("/tmp/repo/other", "2026-07-24T00:00:00.000Z")).toEqual([]);
  });

  it("deduplicates identical evidence", () => {
    const index = new ReachabilityIndex();
    const root = {
      code: "active-session",
      source: "codex",
      path: "/tmp/repo",
      detail: "active",
    };
    index.add(root);
    index.add(root);

    expect(index.size()).toBe(1);
  });
});
