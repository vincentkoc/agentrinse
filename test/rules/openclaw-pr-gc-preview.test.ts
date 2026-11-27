import { expect, it } from "vitest";
import {
  previewComplete,
  previewOwnerPrefix,
  readPrGcPreview,
} from "../../src/rules/openclaw/pr-gc-preview.js";

const owner = "/example/repo";
const positive = "would remove .worktrees/pr-1 (PR #1 state=MERGED)";
const parse = (text: string) =>
  readPrGcPreview(
    (async function* () {
      yield Buffer.from(text);
    })(),
    owner,
  );
const frame = (lines: string[]) =>
  [previewOwnerPrefix + owner, ...lines, previewComplete, ""].join("\n");

it("recognizes native preserved and lock diagnostics without echoing commands or doubling rows", async () => {
  const data = await parse(
    [
      positive,
      "Preserving .worktrees/pr-2: worktree has local changes or is locked. Review its contents and ownership before cleanup.",
      "skipping .worktrees/pr-2 (cleanup incomplete)",
      "skipping .worktrees/pr-3 (PR #3 operation lock is orphaned)",
      "After verifying that no PR #3 tools remain, recover the exact owner with:",
      "  scripts/pr lock-recover 3 " + "a".repeat(40) + " --confirmed-no-running-tools",
      "would remove .worktrees/pr-4 (failed template clone)",
      "skipping .worktrees/pr-5 (merge evidence preserved)",
      "skipping .worktrees/pr-6 (PR #6 has an active scripts/pr operation)",
      "skipping .worktrees/pr-7 (PR #7 operation lock state is indeterminate)",
      "skipping .worktrees/pr-bad (could not parse PR number)",
      "",
    ].join("\n"),
  );
  expect(data).toMatchObject({
    source: "supplied-stdout",
    invalidLines: 0,
    excludedNonPrNames: 1,
    preservationDiagnostics: 1,
    lockRecoveryDiagnostics: 1,
  });
  expect(data.rows.size).toBe(7);
  expect(data.rows.get("3")).toEqual({ native: "skipped", reason: "operation-lock-orphaned" });
  expect(data.rows.get("4")).toEqual({ native: "failed-template" });
});

it.each([
  [positive, "removed .worktrees/pr-2 (PR #2 state=CLOSED)"],
  [positive, positive],
  [positive, "skipping .worktrees/pr-1 (merge evidence preserved)"],
  ["would remove .worktrees/pr-1 (PR #2 state=MERGED)"],
  ["would remove .worktrees/pr-01 (PR #01 state=CLOSED)"],
  ["would remove /outside/.worktrees/pr-1 (PR #1 state=CLOSED)"],
  ["would remove .worktrees/pr-1/nested (failed template clone)"],
  ["would remove .worktrees/pr-1 (PR #1 state=OPEN)"],
  [positive, "No merged/closed PR worktrees eligible for removal."],
  [positive, "After verifying that no PR #1 tools remain, recover the exact owner with:"],
  [positive, "  scripts/pr lock-recover 1 " + "a".repeat(40) + " --confirmed-no-running-tools"],
])("withholds the whole malformed or mixed preview", async (...lines) => {
  expect((await parse(frame(lines))).source).toBe("invalid");
});
it("requires completion and exact frame owner, handles empty scopes, and bounds input", async () => {
  expect((await parse(frame(["No merged/closed PR worktrees eligible for removal."]))).source).toBe(
    "owner-bound-complete",
  );
  expect((await parse(frame([positive]).replace(owner, owner + "-other"))).source).toBe("invalid");
  expect((await parse(frame([positive]).replace(previewComplete + "\n", ""))).source).toBe(
    "invalid",
  );
  expect((await parse(frame([positive]).trimEnd())).source).toBe("invalid");
  await expect(parse("x".repeat(4 * 1024 * 1024 + 1))).rejects.toThrow("4 MiB");
  await expect(parse("\n".repeat(20_001))).rejects.toThrow("20000");
});
