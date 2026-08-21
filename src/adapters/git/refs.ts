export type RepositoryGitRunner = (args: string[]) => Promise<string>;

async function gitRefContainsHead(
  runGit: RepositoryGitRunner,
  head: string,
  gitRef: string,
): Promise<boolean> {
  if (gitRef.startsWith("refs/tags/")) {
    return (await runGit(["rev-parse", `${gitRef}^{commit}`])).trim() === head;
  }
  return (await runGit(["rev-list", "--max-count=1", head, "--not", gitRef])).trim() === "";
}

export async function isPushedHead(
  runGit: RepositoryGitRunner,
  input: {
    head: string;
    upstream?: string;
    ahead: number;
    remoteConfigured: boolean;
    detached: boolean;
  },
): Promise<boolean> {
  if (!input.remoteConfigured || input.detached) {
    return false;
  }
  if (input.upstream === undefined) {
    return (
      (await runGit(["rev-list", "--max-count=1", input.head, "--not", "--remotes"])).trim() === ""
    );
  }
  const upstream = input.upstream.startsWith("refs/")
    ? input.upstream
    : `refs/remotes/${input.upstream}`;
  return input.ahead === 0 && (await gitRefContainsHead(runGit, input.head, upstream));
}

export async function matchingGitRefPins(
  runGit: RepositoryGitRunner,
  head: string,
  gitRefs: readonly string[],
): Promise<string[]> {
  const matches: string[] = [];
  for (const gitRef of gitRefs) {
    if (await gitRefContainsHead(runGit, head, gitRef)) {
      matches.push(gitRef);
    }
  }
  return matches;
}
