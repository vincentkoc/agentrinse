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

export async function inspectArtifactGitState(
  projectRoot: string,
  name: ArtifactName,
): Promise<ArtifactGitState> {
  let directory = projectRoot;
  let repositoryFound = false;

  while (true) {
    try {
      const marker = await lstat(join(directory, ".git"));
      if (!marker.isFile() && !marker.isDirectory()) {
        return { status: "unknown", reason: "Git metadata is not a regular file or directory" };
      }
      repositoryFound = true;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return {
          status: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (!repositoryFound) {
    return { status: "clear" };
  }

  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS") {
      delete env[key];
    }
  }

  try {
    const result = await execFileAsync(
      "git",
      ["-C", projectRoot, "ls-files", "--cached", "-z", "--", `:(literal,icase)${name}`],
      { encoding: "utf8", env, maxBuffer: 1024 * 1024, timeout: 10_000 },
    );
    return result.stdout === "" ? { status: "clear" } : { status: "tracked" };
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
