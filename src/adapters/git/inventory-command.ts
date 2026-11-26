import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function inventoryGit(
  path: string,
  args: string[],
  signal: AbortSignal,
  limits = { timeoutMs: 5_000, maxBuffer: 8 * 1024 * 1024 },
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=",
      "-c",
      "protocol.allow=never",
      "-C",
      path,
      ...args,
    ],
    {
      env: {
        ...env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
      },
      encoding: "utf8",
      signal,
      timeout: limits.timeoutMs,
      maxBuffer: limits.maxBuffer,
    },
  );
  return stdout;
}
