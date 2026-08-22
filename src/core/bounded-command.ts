import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

type SpawnCommand = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type BoundedCommandOptions = {
  timeoutMs: number;
  maxOutputBytes: number;
  spawnCommand?: SpawnCommand;
};

export type BoundedCommandResult = {
  stdout: string;
  stderr: string;
};

export class BoundedCommandError extends Error {
  readonly code: string | number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      code: string | number;
      stdout: string;
      stderr: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BoundedCommandError";
    this.code = options.code;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

export function runBoundedCommand(
  command: string,
  args: string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = (options.spawnCommand ?? spawn)(command, args, { stdio: "pipe" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    child.stdin.end();

    const output = () => ({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });

    const stop = (code: string, message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new BoundedCommandError(message, { code, ...output() }));
    };

    const capture = (chunks: Buffer[], chunk: Buffer | string): void => {
      if (settled) {
        return;
      }
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = options.maxOutputBytes - outputBytes;
      if (value.length > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          outputBytes += remaining;
        }
        stop("ENOBUFS", `${command} output exceeded the ${options.maxOutputBytes}-byte limit`);
        return;
      }
      chunks.push(value);
      outputBytes += value.length;
    };

    child.stdout.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer | string) => capture(stderr, chunk));

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const value = output();
      const code =
        error instanceof Error && "code" in error
          ? String((error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED")
          : "SPAWN_FAILED";
      reject(
        new BoundedCommandError(
          error instanceof Error ? error.message : `could not start ${command}`,
          { code, ...value, cause: error },
        ),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const value = output();
      if (code === 0) {
        resolve(value);
        return;
      }
      reject(
        new BoundedCommandError(
          `${command} exited with ${signal === null ? `status ${String(code)}` : signal}`,
          {
            code: code ?? signal ?? "COMMAND_FAILED",
            ...value,
          },
        ),
      );
    });

    const timer = setTimeout(() => {
      stop("ETIMEDOUT", `${command} timed out after ${options.timeoutMs}ms`);
    }, options.timeoutMs);
  });
}
