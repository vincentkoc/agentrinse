export type RepositoryGitRunner = (args: string[]) => Promise<string>;

function lines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function listGitRefsForCommit(
  runGit: RepositoryGitRunner,
  head: string,
): Promise<{ containingRefs: string[]; gitRefs: string[] }> {
  const [containingRefs, tagRefs] = await Promise.all([
    runGit([
      "for-each-ref",
      "--contains",
      head,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ]).then(lines),
    runGit(["for-each-ref", "--points-at", head, "--format=%(refname)", "refs/tags"]).then(lines),
  ]);
  return {
    containingRefs,
    gitRefs: [...new Set([...containingRefs, ...tagRefs])].sort(),
  };
}
