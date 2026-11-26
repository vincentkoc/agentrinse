import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { ArtifactName } from "../contracts/action.js";

const execFileAsync = promisify(execFile);

export type ArtifactGitState =
  | { status: "clear" }
  | { status: "tracked" }
  | { status: "unknown"; reason: string };

export async function findArtifactGitRepository(projectRoot: string): Promise<string | undefined> {
  let directory = projectRoot;
  while (true) {
    try {
      const marker = await lstat(join(directory, ".git"));
      if (!marker.isFile() && !marker.isDirectory())
        throw new Error("Git metadata is not a regular file or directory");
      return directory;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function runArtifactGit(projectRoot: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) {
      delete env[key];
    }
  }

  // Commit ancestry in a promisor clone is evidence only when it is already local.
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "";
  env.GIT_TERMINAL_PROMPT = "0";
  const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    env,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

export async function inspectArtifactGitState(
  projectRoot: string,
  name: ArtifactName,
): Promise<ArtifactGitState> {
  try {
    if (!(await findArtifactGitRepository(projectRoot))) return { status: "clear" };
    const output = await runArtifactGit(projectRoot, [
      "ls-files",
      "--cached",
      "-z",
      "--",
      `:(literal,icase)${name}`,
    ]);
    return output === "" ? { status: "clear" } : { status: "tracked" };
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
