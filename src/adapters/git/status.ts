export type GitStatusFacts = {
  head?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  ignored: number;
};

function changeFlags(token: string): { staged: boolean; modified: boolean } {
  return {
    staged: token[0] !== undefined && token[0] !== ".",
    modified: token[1] !== undefined && token[1] !== ".",
  };
}

export function parseGitStatusPorcelainV2(input: string): GitStatusFacts {
  const facts: GitStatusFacts = {
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    ignored: 0,
  };
  let expectRenameSource = false;

  for (const token of input.split("\0")) {
    if (token === "") {
      continue;
    }
    if (expectRenameSource) {
      expectRenameSource = false;
      continue;
    }
    if (token.startsWith("# branch.oid ")) {
      const value = token.slice("# branch.oid ".length);
      if (value !== "(initial)") {
        facts.head = value;
      }
      continue;
    }
    if (token.startsWith("# branch.head ")) {
      const value = token.slice("# branch.head ".length);
      if (value !== "(detached)") {
        facts.branch = value;
      }
      continue;
    }
    if (token.startsWith("# branch.upstream ")) {
      facts.upstream = token.slice("# branch.upstream ".length);
      continue;
    }
    if (token.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(token);
      if (match === null) {
        throw new Error(`invalid branch.ab record: ${token}`);
      }
      facts.ahead = Number.parseInt(match[1]!, 10);
      facts.behind = Number.parseInt(match[2]!, 10);
      continue;
    }
    if (token.startsWith("1 ") || token.startsWith("2 ")) {
      const flags = changeFlags(token.slice(2, 4));
      facts.staged += Number(flags.staged);
      facts.modified += Number(flags.modified);
      expectRenameSource = token.startsWith("2 ");
      continue;
    }
    if (token.startsWith("u ")) {
      facts.conflicted += 1;
      facts.staged += 1;
      facts.modified += 1;
      continue;
    }
    if (token.startsWith("? ")) {
      facts.untracked += 1;
      continue;
    }
    if (token.startsWith("! ")) {
      facts.ignored += 1;
      continue;
    }
    if (token.startsWith("# ")) {
      continue;
    }
    throw new Error(`unknown porcelain v2 record: ${token}`);
  }

  return facts;
}

export function countStatusSuppressedIndexEntries(input: string): number {
  return input
    .split("\0")
    .filter(
      (entry) =>
        entry.startsWith("S ") ||
        (entry.length >= 2 && entry[1] === " " && /^[a-z]$/u.test(entry[0]!)),
    ).length;
}
