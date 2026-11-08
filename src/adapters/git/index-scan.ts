import { spawn } from "node:child_process";

import { isStatusSuppressedIndexEntry } from "./status.js";

/**
 * Visits NUL-separated records from one Git command. Returning `true` stops the
 * scan early. A thrown visitor error rejects the scan.
 */
export type GitRecordScanner = (
  args: string[],
  visit: (record: string) => boolean | void,
) => Promise<void>;

export type StreamingGitRecordScannerOptions = {
  timeoutMs?: number;
  executable?: string;
};

const MAX_STDERR_CHARS = 64 * 1024;

/**
 * Adapts a buffered runner, such as an injected test runner, to the scanner
 * contract. Production callers use the streaming scanner instead.
 */
export function bufferedGitRecordScanner(
  runGit: (args: string[]) => Promise<string>,
): GitRecordScanner {
  return async (args, visit) => {
    for (const record of (await runGit(args)).split("\0")) {
      if (record !== "" && visit(record) === true) {
        return;
      }
    }
  };
}

/**
 * Index-wide listings such as `git ls-files -z --stage` grow with every tracked
 * file. Buffering them behind a fixed `maxBuffer` turns a large repository into
 * an inspection failure, so records are parsed as they arrive and only the
 * visitor's own state is retained.
 */
export function streamingGitRecordScanner(
  options: StreamingGitRecordScannerOptions = {},
): GitRecordScanner {
  const executable = options.executable ?? "git";
  return (args, visit) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const command = [executable, ...args].join(" ");
      let pending = "";
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      const consume = (record: string): boolean => {
        try {
          return visit(record) === true;
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
          return true;
        }
      };

      if (options.timeoutMs !== undefined) {
        const timeoutMs = options.timeoutMs;
        timer = setTimeout(() => {
          settle(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk: string) => {
        if (settled) {
          return;
        }
        pending += chunk;
        let start = 0;
        for (let end = pending.indexOf("\0"); end !== -1; end = pending.indexOf("\0", start)) {
          const record = pending.slice(start, end);
          start = end + 1;
          if (record !== "" && consume(record)) {
            settle();
            return;
          }
        }
        pending = pending.slice(start);
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR_CHARS) {
          stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
        }
      });
      child.once("error", (error) => settle(error));
      child.once("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim();
          settle(
            new Error(
              `Command failed: ${command}${detail === "" ? "" : `\n${detail}`}${
                signal === null ? "" : ` (${signal})`
              }`,
            ),
          );
          return;
        }
        if (pending !== "" && consume(pending)) {
          settle();
          return;
        }
        settle();
      });
    });
}

/** Whether any index entry is a gitlink (submodule), stopping at the first. */
export async function indexHasGitlink(
  scan: GitRecordScanner,
  worktreePath: string,
): Promise<boolean> {
  let found = false;
  await scan(["-C", worktreePath, "ls-files", "-z", "--stage"], (record) => {
    found = record.startsWith("160000 ");
    return found;
  });
  return found;
}

/** Counts assume-unchanged and skip-worktree index entries. */
export async function countIndexStatusSuppressedEntries(
  scan: GitRecordScanner,
  worktreePath: string,
): Promise<number> {
  let count = 0;
  await scan(["-C", worktreePath, "ls-files", "-z", "-v"], (record) => {
    if (isStatusSuppressedIndexEntry(record)) {
      count += 1;
    }
  });
  return count;
}
