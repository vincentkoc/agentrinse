import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProcessPathMatch = {
  pid: number;
  source: "cwd" | "fd";
  path: string;
};

export type ProcessOwnershipResult =
  | { status: "idle"; matches: [] }
  | { status: "busy"; matches: ProcessPathMatch[] }
  | { status: "unknown"; matches: ProcessPathMatch[]; reason: string };

export type ProcessOwnershipOptions = {
  platform?: NodeJS.Platform;
  procRoot?: string;
  uid?: number;
  runLsof?: (target: string) => Promise<{ stdout: string; stderr: string }>;
};

function isInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function cleanProcLink(value: string): string {
  return value.endsWith(" (deleted)") ? value.slice(0, -" (deleted)".length) : value;
}

function isGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

async function readProcessUid(statusPath: string): Promise<number | undefined> {
  const status = await readFile(statusPath, "utf8");
  const uidLine = status.split("\n").find((line) => line.startsWith("Uid:"));
  const uid = uidLine?.split(/\s+/)[1];
  return uid === undefined ? undefined : Number.parseInt(uid, 10);
}

async function inspectLinux(
  target: string,
  options: ProcessOwnershipOptions,
): Promise<ProcessOwnershipResult> {
  const procRoot = options.procRoot ?? "/proc";
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    return {
      status: "unknown",
      matches: [],
      reason: "current user identity is unavailable",
    };
  }

  const matches: ProcessPathMatch[] = [];
  let incomplete = false;
  const entries = await readdir(procRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const pid = Number.parseInt(entry.name, 10);
    const processRoot = resolve(procRoot, entry.name);

    try {
      const processUid = await readProcessUid(resolve(processRoot, "status"));
      if (processUid !== uid) {
        continue;
      }

      const cwd = cleanProcLink(await readlink(resolve(processRoot, "cwd")));
      if (isInside(target, cwd)) {
        matches.push({ pid, source: "cwd", path: cwd });
      }

      const descriptors = await readdir(resolve(processRoot, "fd"));
      for (const descriptor of descriptors) {
        try {
          const path = cleanProcLink(await readlink(resolve(processRoot, "fd", descriptor)));
          if (isAbsolute(path) && isInside(target, path)) {
            matches.push({ pid, source: "fd", path });
          }
        } catch (error) {
          if (!isGone(error)) {
            incomplete = true;
          }
        }
      }
    } catch (error) {
      if (!isGone(error)) {
        incomplete = true;
      }
    }
  }

  if (matches.length > 0) {
    return { status: "busy", matches };
  }
  if (incomplete) {
    return inspectWithLsof(target, options);
  }
  return { status: "idle", matches: [] };
}

async function inspectWithLsof(
  target: string,
  options: ProcessOwnershipOptions,
): Promise<ProcessOwnershipResult> {
  try {
    const result =
      options.runLsof === undefined
        ? await execFileAsync("lsof", ["-nP", "+D", target, "-Fpcfn"], {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            timeout: 10_000,
          })
        : await options.runLsof(target);
    if (result.stderr !== "") {
      return {
        status: "unknown",
        matches: [],
        reason: `lsof reported an incomplete scan: ${result.stderr.trim()}`,
      };
    }

    const matches: ProcessPathMatch[] = [];
    let pid: number | undefined;

    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) {
        pid = Number.parseInt(line.slice(1), 10);
      } else if (line.startsWith("n") && pid !== undefined) {
        const path = line.slice(1);
        if (isInside(target, path)) {
          matches.push({ pid, source: "fd", path });
        }
      }
    }

    return matches.length > 0 ? { status: "busy", matches } : { status: "idle", matches: [] };
  } catch (error) {
    const commandError = error as {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    if (
      Number(commandError.code) === 1 &&
      (commandError.stdout ?? "") === "" &&
      (commandError.stderr ?? "") === ""
    ) {
      return { status: "idle", matches: [] };
    }
    return {
      status: "unknown",
      matches: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function findProcessesUsingPath(
  target: string,
  options: ProcessOwnershipOptions = {},
): Promise<ProcessOwnershipResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    return inspectLinux(resolve(target), options);
  }
  if (platform === "darwin") {
    return inspectWithLsof(resolve(target), options);
  }
  return {
    status: "unknown",
    matches: [],
    reason: `process ownership is unsupported on ${platform}`,
  };
}
