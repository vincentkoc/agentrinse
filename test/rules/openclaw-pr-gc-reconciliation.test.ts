import { expect, it } from "vitest";
import { reconcilePrGc } from "../../src/rules/openclaw/pr-gc-reconciliation.js";
import { previewComplete, previewOwnerPrefix } from "../../src/rules/openclaw/pr-gc-preview.js";

const owner = "/project/openclaw";
const preview = [
  previewOwnerPrefix + owner,
  "would remove .worktrees/pr-8 (PR #8 state=MERGED)",
  "skipping .worktrees/pr-9 (PR #9 has an active scripts/pr operation)",
  previewComplete,
  "",
].join("\n");
const removed = "removed .worktrees/pr-8 (PR #8 state=MERGED)";
const frame = (...lines: string[]) =>
  [
    "agentrinse-openclaw-pr-apply-v1 " + owner,
    ...lines,
    "agentrinse-openclaw-pr-apply-exit 0",
    "",
  ].join("\n");

it("finds newly merged PRs outside the frozen list even when branch cleanup refused", () => {
  const data = reconcilePrGc(
    owner,
    preview,
    frame(
      "warning: deleting branch 'pr-8-prep' that has been merged to",
      "         'refs/openclaw/pr-merge-outcomes/8', but not yet merged to HEAD",
      "Deleted branch pr-8-prep (was 123456a).",
      removed,
      "Deleted branch temp/pr-10 (was 123456b).",
      "error: the branch 'pr-10' is not fully merged",
      "hint: If you are sure you want to delete it, run 'git branch -D pr-10'",
      'hint: Disable this message with "git config set advice.forceDeleteBranch false"',
      "skipping .worktrees/pr-10 (cleanup incomplete)",
      "removed .worktrees/pr-9 (PR #9 state=CLOSED)",
    ),
  );
  expect(data).toMatchObject({
    coverage: "framed-complete",
    reportedRemoved: 2,
    incompleteOutcomes: 1,
    currentFilesystem: "not-observed",
    outsideAttempts: ["9", "10"],
    possibleOutsideAttempts: [],
  });
  expect(data.rows[2]).toMatchObject({
    pr: "10",
    preview: null,
    outcome: "partial-branch-cleanup",
    branches: [
      { branch: "temp/pr-10", result: "reported-deleted" },
      { branch: "pr-10", result: "refused-unmerged" },
    ],
  });
  expect(JSON.stringify(data)).not.toContain("branch -D");
});

it("distinguishes reported refusal and ambiguous cleanup from an actual branch attempt", () => {
  const data = reconcilePrGc(
    owner,
    preview,
    frame(
      "Preserving .worktrees/pr-10: worktree has local changes or is locked. Review its contents and ownership before cleanup.",
      "skipping .worktrees/pr-10 (cleanup incomplete)",
      "skipping .worktrees/pr-11 (cleanup incomplete)",
      "Skipping local branch delete for pr-12; checked out in worktree /private/example",
      "skipping .worktrees/pr-12 (cleanup incomplete)",
      "No merged/closed PR worktrees removed.",
    ),
  );
  expect(data.outsideAttempts).toEqual(["12"]);
  expect(data.possibleOutsideAttempts).toEqual(["11"]);
  expect(data.rows.find((r) => r.pr === "10")?.outcome).toBe("reported-preserved");
  expect(data.rows[0]?.outcome).toBe("unreported");
  expect(JSON.stringify(data)).not.toContain("/private/example");
});

it("reports observed rows in raw logs and withholds completeness for broken, conflicting or mixed evidence", () => {
  expect(reconcilePrGc(owner, preview, removed + "\n")).toMatchObject({
    applySource: "supplied-output",
    coverage: "unverified",
    reportedRemoved: 1,
  });
  for (const apply of [
    frame(removed, removed),
    frame(removed + "x"),
    frame(removed.replace("#8", "#1")),
    frame(removed).trimEnd(),
    frame(removed).replace(owner, "/other"),
    frame(removed, "would remove .worktrees/pr-8 (PR #8 state=MERGED)"),
    frame("Deleted branch pr-99 (was 123456a)."),
    frame(removed, "unknown private text"),
  ]) {
    const data = reconcilePrGc(owner, preview, apply);
    expect(data.applySource).toBe("invalid");
    expect(data.coverage).toBe("unverified");
    expect(JSON.stringify(data)).not.toContain("unknown private text");
  }
  expect(reconcilePrGc(owner, preview, frame(removed).replace("exit 0", "exit 1"))).toMatchObject({
    applyExit: 1,
    coverage: "unverified",
  });
  expect(reconcilePrGc(owner, preview.replace(owner, "/other"), frame(removed)).coverage).toBe(
    "unverified",
  );
  expect(() => reconcilePrGc(owner, preview, "\n".repeat(20_001))).toThrow("20000");
});

it("keeps failed-template operations outside the MERGED/CLOSED selection and counts silent selections", () => {
  const frozen = [
    previewOwnerPrefix + owner,
    "would remove .worktrees/pr-1 (failed template clone)",
    "would remove .worktrees/pr-2 (PR #2 state=MERGED)",
    "would remove .worktrees/pr-3 (PR #3 state=CLOSED)",
    "would remove .worktrees/pr-4 (failed template clone)",
    previewComplete,
    "",
  ].join("\n");
  const report = reconcilePrGc(
    owner,
    frozen,
    frame(
      "removed .worktrees/pr-1 (PR #1 state=MERGED)",
      "removed .worktrees/pr-2 (failed template clone)",
      "removed .worktrees/pr-4 (failed template clone)",
    ),
  );
  expect(report).toMatchObject({
    outsideAttempts: ["1", "4"],
    actionKindDrift: ["1", "2"],
    selectedUnreported: 1,
    reportedRemoved: 1,
    reportedFailedTemplateRemovals: 2,
  });
  expect(report.rows[1]?.outcome).toBe("reported-failed-template-removal");
});
