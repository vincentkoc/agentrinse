export type RepositoryGitRunner = (args: string[]) => Promise<string>;

async function gitRefExists(runGit: RepositoryGitRunner, gitRef: string): Promise<boolean> {
  const refs = (await runGit(["for-each-ref", "--format=%(refname)", "--", gitRef]))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (refs.some((ref) => !ref.startsWith("refs/"))) {
    throw new Error(`invalid Git ref inspection output for ${gitRef}`);
  }
  return refs.includes(gitRef);
}

async function gitRefContainsHead(
  runGit: RepositoryGitRunner,
  head: string,
  gitRef: string,
  requireCompleteHistory = false,
): Promise<boolean> {
  if (!(await gitRefExists(runGit, gitRef))) {
    return false;
  }
  if (gitRef.startsWith("refs/tags/")) {
    return (await runGit(["rev-parse", `${gitRef}^{commit}`])).trim() === head;
  }
  const contains =
    (await runGit(["rev-list", "--max-count=1", head, "--not", gitRef])).trim() === "";
  if (
    !contains &&
    requireCompleteHistory &&
    (await runGit(["rev-parse", "--is-shallow-repository"])).trim() !== "false"
  ) {
    throw new Error("shallow Git history cannot rule out an artifact ref pin");
  }
  return contains;
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
  options: { requireCompleteHistory?: boolean } = {},
): Promise<string[]> {
  const matches: string[] = [];
  for (const gitRef of gitRefs) {
    if (await gitRefContainsHead(runGit, head, gitRef, options.requireCompleteHistory)) {
      matches.push(gitRef);
    }
  }
  return matches;
}
