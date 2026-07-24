import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RunProcessCommand = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type ProcessIdentityDependencies = {
  runProcessCommand?: RunProcessCommand;
};

export type ProcessIdentityInspection =
  | { status: "alive"; identity: string }
  | { status: "dead" }
  | { status: "unknown"; reason: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function probePid(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    return code === "ESRCH" ? "dead" : code === "EPERM" ? "alive" : "unknown";
  }
}

function parseLinuxStartTime(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1) {
    return undefined;
  }
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  return fieldsAfterCommand[19];
}

async function inspectLinuxProcess(pid: number): Promise<ProcessIdentityInspection> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTime = parseLinuxStartTime(stat);
    return startTime === undefined
      ? { status: "unknown", reason: `could not parse /proc/${pid}/stat` }
      : { status: "alive", identity: `linux-proc-start:${startTime}` };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ESRCH") {
      return { status: "dead" };
    }
    return {
      status: "unknown",
      reason: `could not inspect /proc/${pid}/stat${code === undefined ? "" : ` (${code})`}`,
    };
  }
}

async function inspectMacProcess(
  pid: number,
  dependencies: ProcessIdentityDependencies,
): Promise<ProcessIdentityInspection> {
  try {
    const runProcessCommand =
      dependencies.runProcessCommand ?? (execFileAsync as RunProcessCommand);
    const { stdout } = await runProcessCommand("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
    });
    const startTime = stdout.trim().replace(/\s+/gu, " ");
    if (startTime.length === 0) {
      return probePid(pid) === "dead"
        ? { status: "dead" }
        : { status: "unknown", reason: `ps returned no start identity for PID ${pid}` };
    }
    return { status: "alive", identity: `darwin-ps-start:${startTime}` };
  } catch {
    const pidStatus = probePid(pid);
    if (pidStatus === "dead") {
      return { status: "dead" };
    }
    return {
      status: "unknown",
      reason: `could not inspect process start identity for PID ${pid}`,
    };
  }
}

export async function inspectProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  dependencies: ProcessIdentityDependencies = {},
): Promise<ProcessIdentityInspection> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "unknown", reason: `invalid process ID ${pid}` };
  }
  if (platform === "linux") {
    return inspectLinuxProcess(pid);
  }
  if (platform === "darwin") {
    return inspectMacProcess(pid, dependencies);
  }

  const status = probePid(pid);
  return status === "dead"
    ? { status: "dead" }
    : {
        status: "unknown",
        reason: `process start identity is unsupported on ${platform}`,
      };
}
