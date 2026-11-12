import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FIXTURE_GIT_NAME = "AgentRinse Fixture";
export const FIXTURE_GIT_EMAIL = "fixture@example.test";

/** Host git config (commit signing, LFS, credential helpers) must not affect fixtures. */
export function fixtureGitEnv(home?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (
      key === "GIT_CONFIG_COUNT" ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      continue;
    }
    if (key.startsWith("GIT_")) {
      continue;
    }
    env[key] = value;
  }
  if (home !== undefined) {
    env.HOME = home;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_AUTHOR_NAME = FIXTURE_GIT_NAME;
  env.GIT_AUTHOR_EMAIL = FIXTURE_GIT_EMAIL;
  env.GIT_COMMITTER_NAME = FIXTURE_GIT_NAME;
  env.GIT_COMMITTER_EMAIL = FIXTURE_GIT_EMAIL;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

const CONFIG_ARGS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "filter.lfs.required=false",
  "-c",
  `user.name=${FIXTURE_GIT_NAME}`,
  "-c",
  `user.email=${FIXTURE_GIT_EMAIL}`,
] as const;

export async function runFixtureGit(
  args: string[],
  options: {
    cwd?: string;
    home?: string;
    maxBuffer?: number;
    encoding?: "utf8";
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", [...CONFIG_ARGS, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: fixtureGitEnv(options.home),
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
  } satisfies ExecFileOptionsWithStringEncoding);
  return { stdout: result.stdout, stderr: result.stderr };
}

export function fixtureGitSpawnOptions(home?: string): {
  env: NodeJS.ProcessEnv;
  argvPrefix: string[];
} {
  return { env: fixtureGitEnv(home), argvPrefix: [...CONFIG_ARGS] };
}

export function spawnFixtureGit(
  args: string[],
  options: { home?: string; encoding?: "utf8"; maxBuffer?: number } = {},
) {
  return execFile("git", [...CONFIG_ARGS, ...args], {
    encoding: "utf8",
    env: fixtureGitEnv(options.home),
    maxBuffer: options.maxBuffer,
  });
}
