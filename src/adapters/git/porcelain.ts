export type GitWorktreeRecord = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
};

export function parseWorktreePorcelain(input: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = [];
  let current: GitWorktreeRecord | undefined;

  const pushCurrent = () => {
    if (current !== undefined) {
      records.push(current);
      current = undefined;
    }
  };

  for (const token of input.split("\0")) {
    if (token === "") {
      continue;
    }

    if (token.startsWith("worktree ")) {
      pushCurrent();
      current = {
        path: token.slice("worktree ".length),
        detached: false,
        bare: false,
      };
      continue;
    }

    if (current === undefined) {
      throw new Error(`worktree porcelain field before record: ${token}`);
    }

    if (token.startsWith("HEAD ")) {
      current.head = token.slice("HEAD ".length);
    } else if (token.startsWith("branch ")) {
      current.branch = token.slice("branch ".length);
    } else if (token === "detached") {
      current.detached = true;
    } else if (token === "bare") {
      current.bare = true;
    } else if (token === "locked") {
      current.locked = "";
    } else if (token.startsWith("locked ")) {
      current.locked = token.slice("locked ".length);
    } else if (token === "prunable") {
      current.prunable = "";
    } else if (token.startsWith("prunable ")) {
      current.prunable = token.slice("prunable ".length);
    }
  }

  pushCurrent();
  return records;
}
