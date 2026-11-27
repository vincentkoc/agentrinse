import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inventoryWorktrees, executeWorktreesCommand } from "../../src/commands/worktrees.js";
import { parseWorktreePorcelain } from "../../src/adapters/git/porcelain.js";
import { selectedBinding } from "../../src/rules/git/selected-binding.js";
import { openClawPrProject, reportPrWorktrees } from "../../src/rules/openclaw/pr-worktrees.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import {
  previewComplete,
  previewOwnerPrefix,
  readPrGcPreview,
} from "../../src/rules/openclaw/pr-gc-preview.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { runFixtureGit } from "../helpers/git.js";

const readMounts = async () => parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
function input(value: string) {
  return (async function* () {
    yield Buffer.from(value);
  })();
}
async function fixture() {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-pr-preview-")));
  const owner = join(home, "repo");
  const root = join(owner, ".worktrees");
  await runFixtureGit(["init", "-b", "main", owner]);
  const git = (args: string[]) => runFixtureGit(["-C", owner, ...args]);
  await git(["remote", "add", "origin", "https://github.com/openclaw/openclaw.git"]);
  await writeFile(join(owner, ".gitignore"), ".local/\n");
  await writeFile(join(owner, "artifact"), "a".repeat(4096));
  await git(["add", ".gitignore", "artifact"]);
  await git(["commit", "-m", "fixture"]);
  return {
    owner,
    root,
    git,
    options: {
      home,
      root: [],
      repo: [owner],
      projectRoots: true,
      openclawPrGcStdin: true,
      measure: true,
    },
  };
}

it.skipIf(process.platform === "win32")(
  "joins the native preview to direct checkouts, preserving locked, failed and unreported PRs",
  async () => {
    const { owner, root, git, options } = await fixture();
    for (const pr of [1, 2, 3, 4, 8])
      await git(["worktree", "add", "--detach", join(root, "pr-" + pr)]);
    await git(["worktree", "lock", join(root, "pr-2")]);
    await git(["update-ref", "refs/openclaw/pr-operation-locks/3", "HEAD"]);
    await mkdir(join(root, "pr-5", "nested"), { recursive: true });
    await writeFile(join(root, "pr-5", "nested", "SECRET"), "fixture");
    await symlink(join(root, "pr-1"), join(root, "pr-6"), "dir");
    await mkdir(join(root, "pr-8", ".local"));
    await writeFile(join(root, "pr-8", ".local", "private-proof.mjs"), "retained");
    const lines = [
      "would remove .worktrees/pr-1 (PR #1 state=MERGED)",
      "would remove .worktrees/pr-2 (PR #2 state=CLOSED)",
      "would remove .worktrees/pr-3 (PR #3 state=MERGED)",
      "would remove .worktrees/pr-5 (failed template clone)",
      "would remove .worktrees/pr-6 (PR #6 state=MERGED)",
      "would remove .worktrees/pr-7 (PR #7 state=CLOSED)",
      "would remove .worktrees/pr-8 (PR #8 state=MERGED)",
    ];
    const stream = [previewOwnerPrefix + owner, ...lines, previewComplete, ""].join("\n");
    const run = async (value: string, maxEntries = "100") =>
      (await inventoryWorktrees({ ...options, maxEntries }, { readMounts, input: input(value) }))
        .openClawPrWorktrees![0]!;
    const full = await run(stream);
    expect(full.summary).toMatchObject({
      reportedWouldRemove: 6,
      corroboratedWouldRemove: 4,
      ownerReview: 1,
      skipped: 3,
      unknown: 4,
      untrackedOrIgnoredPresent: 1,
      reportedSizesComplete: 4,
      reportedSizesUnknown: 2,
      reclaimableBytes: null,
    });
    expect(full.summary.reportedCheckoutLogicalBytes).toBeGreaterThanOrEqual(4096);
    expect(full.rows.map((row) => [row.pr, row.reason])).toEqual([
      ["1", "corroborated-preview"],
      ["2", "native-lock-or-prunable"],
      ["3", "native-lock-or-prunable"],
      ["4", "absent-from-preview"],
      ["5", "failed-template-requires-owner"],
      ["6", "checkout-unverified"],
      ["7", "checkout-unverified"],
      ["8", "untracked-or-ignored-material-needs-review"],
    ]);
    const ordinary = await inventoryWorktrees(
      { ...options, openclawPrGcStdin: false, root: [root] },
      { readMounts },
    );
    expect(ordinary.openClawPrWorktrees![0]).toMatchObject({
      source: "not-supplied",
      summary: { ownerReview: 0 },
    });
    const raw = await run(lines.join("\n") + "\n", "1");
    expect(raw.summary).toMatchObject({
      ownerReview: 0,
      corroboratedWouldRemove: 4,
      reportedSizesPartial: 4,
    });
    expect((await run(stream.replace("PR #1 state", "PR #10 state"))).summary.ownerReview).toBe(0);
    for (const json of [true, false]) {
      const redacted = await executeWorktreesCommand(
        { ...options, redact: true, json },
        { readMounts, input: input(stream) },
      );
      expect(redacted).not.toContain(owner);
      expect(redacted).not.toContain("SECRET");
      expect(redacted).not.toContain("private-proof.mjs");
    }
    expect(await readFile(join(root, "pr-1", "artifact"), "utf8")).toHaveLength(4096);
  },
  30_000,
);

it("requires an explicit durable OpenClaw owner and cannot share stdin", async () => {
  const { root, git, options } = await fixture();
  await mkdir(join(root, "pr-1"), { recursive: true });
  await git(["remote", "set-url", "origin", "https://example.test/other/project.git"]);
  const value = "would remove .worktrees/pr-1 (PR #1 state=MERGED)\n";
  const report = await inventoryWorktrees(options, { input: input(value), readMounts });
  expect(report.openClawPrWorktrees![0]).toMatchObject({
    ownerVerified: false,
    summary: { ownerReview: 0, reportedWouldRemove: 1 },
  });
  const ordinary = await inventoryWorktrees(
    { ...options, openclawPrGcStdin: false, root: [root] },
    { readMounts },
  );
  expect(ordinary.openClawPrWorktrees).toBeUndefined();
  await expect(inventoryWorktrees({ ...options, gwtStatusStdin: true })).rejects.toThrow(
    "exclusive stdin",
  );
});

it.skipIf(process.platform === "win32")(
  "withdraws aggregate coverage, bytes and grade on a failed final native snapshot",
  async () => {
    const { owner, root, git } = await fixture();
    const path = join(root, "pr-1"),
      signal = AbortSignal.timeout(10_000);
    await git(["worktree", "add", "--detach", path]);
    const records = parseWorktreePorcelain(
      (await git(["worktree", "list", "--porcelain", "-z"])).stdout,
    );
    const mounts = await readMounts();
    const project = (await openClawPrProject(owner, mounts, records, signal))!;
    project.bindings.set("1", (await selectedBinding(path, project.owner, mounts))!);
    const preview = await readPrGcPreview(
      input(
        [
          previewOwnerPrefix + owner,
          "would remove .worktrees/pr-1 (PR #1 state=MERGED)",
          previewComplete,
          "",
        ].join("\n"),
      ),
      owner,
    );
    let calls = 0;
    const report = await reportPrWorktrees(
      owner,
      project,
      preview,
      [{ path, kind: "registered-linked", size: { status: "complete", logicalBytes: 4096 } }],
      true,
      mounts,
      signal,
      async () => {
        if (++calls === 1) return { records: project.records, locks: new Set<string>() };
        throw new Error("synthetic final snapshot failure");
      },
    );
    expect(calls).toBe(2);
    expect(report).toMatchObject({
      currentNativeEvidence: "unavailable",
      summary: { ownerReview: 0, corroboratedWouldRemove: 0, reportedCheckoutLogicalBytes: null },
      rows: [{ grade: "unknown", size: null }],
    });
  },
);
