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
    index.add({
      code: "provider-managed-worktree",
      source: "codex",
      path: "/tmp/repo",
      scope: "subtree",
      detail: "Codex owns this managed worktree.",
    });
    index.addGlobal({
      code: "unknown-provider-state",
      source: "claude",
      detail: "Claude metadata could not be proven.",
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
        code: "provider-managed-worktree",
        source: "codex",
        observedAt: "2026-07-24T00:00:00.000Z",
        detail: "Codex owns this managed worktree.",
      },
      {
        code: "recent-session",
        source: "claude",
        observedAt: "2026-07-24T00:00:00.000Z",
        detail: "Claude remembers this project.",
        evidenceRef: "claude:project",
      },
      {
        code: "unknown-provider-state",
        source: "claude",
        observedAt: "2026-07-24T00:00:00.000Z",
        detail: "Claude metadata could not be proven.",
      },
    ]);
    expect(index.rootsFor("/tmp/other", "2026-07-24T00:00:00.000Z")).toEqual([
      {
        code: "unknown-provider-state",
        source: "claude",
        observedAt: "2026-07-24T00:00:00.000Z",
        detail: "Claude metadata could not be proven.",
      },
    ]);
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
