import { isAbsolute, resolve } from "node:path";

export const GIT_OPERATION_MARKERS = [
  ["merge", "MERGE_HEAD"],
  ["rebase", "rebase-merge"],
  ["rebase", "rebase-apply"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
  ["bisect", "BISECT_LOG"],
] as const;

export async function findGitOperations(
  worktreePath: string,
  runGit: (args: string[]) => Promise<string>,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const operations = new Set<string>();
  for (const [operation, marker] of GIT_OPERATION_MARKERS) {
    const reportedPath = (
      await runGit(["-C", worktreePath, "rev-parse", "--git-path", marker])
    ).trim();
    const markerPath =
      reportedPath === "" || isAbsolute(reportedPath)
        ? reportedPath
        : resolve(worktreePath, reportedPath);
    if (markerPath !== "" && (await pathExists(markerPath))) {
      operations.add(operation);
    }
  }
  return [...operations].sort();
}
