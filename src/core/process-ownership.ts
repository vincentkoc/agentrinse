import { readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { runBoundedCommand } from "./bounded-command.js";

const LSOF_TIMEOUT_MS = 10_000;
const LSOF_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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
  runLsof?: (target: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

export type LsofFileRecord = {
  pid: number;
  descriptor: string;
  path?: string;
};

type LsofInspection =
  | { status: "complete"; records: LsofFileRecord[] }
  | { status: "unknown"; reason: string };

function isInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function cleanProcLink(value: string): string {
  return value.endsWith(" (deleted)") ? value.slice(0, -" (deleted)".length) : value;
}

export function parseLsofFileRecords(stdout: string): LsofFileRecord[] {
  if (stdout === "") {
    return [];
  }
  const fields = stdout.split("\0");
  const remainder = fields.pop();
  if (remainder !== "\n") {
    throw new Error("malformed lsof output: unterminated set");
  }

  const records: LsofFileRecord[] = [];
  let pid: number | undefined;
  let descriptor: string | undefined;
  let path: string | undefined;

  const finishFile = (): void => {
    if (pid !== undefined && descriptor !== undefined) {
      records.push({
        pid,
        descriptor,
        ...(path === undefined ? {} : { path }),
      });
    }
    descriptor = undefined;
    path = undefined;
  };

  for (const rawField of fields) {
    const field = rawField.startsWith("\n") ? rawField.slice(1) : rawField;
    if (field === "") {
      continue;
    }
    const tag = field[0];
    const value = field.slice(1);
    if (tag === "p") {
      finishFile();
      if (!/^[1-9]\d*$/u.test(value)) {
        throw new Error("malformed lsof output: invalid process id");
      }
      pid = Number.parseInt(value, 10);
    } else if (tag === "f") {
      finishFile();
      if (pid === undefined || value === "") {
        throw new Error("malformed lsof output: invalid file descriptor");
      }
      descriptor = value;
    } else if (tag === "n") {
      if (pid === undefined || descriptor === undefined || value === "") {
        throw new Error("malformed lsof output: unowned path field");
      }
      path = value;
    } else if (tag !== "c") {
      throw new Error(`malformed lsof output: unexpected ${JSON.stringify(tag)} field`);
    }
  }
  finishFile();
  return records;
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
  exact = false,
): Promise<ProcessOwnershipResult> {
  return ownershipFromLsofInspection(target, await collectLsofInspection(target, exact, options));
}

async function collectLsofInspection(
  target: string,
  exact: boolean,
  options: ProcessOwnershipOptions,
): Promise<LsofInspection> {
  try {
    const args = exact ? ["-nP", "-F0pcfn", "--", target] : ["-nP", "-F0pcfn", "+D", target];
    const result =
      options.runLsof === undefined
        ? await runBoundedCommand("lsof", args, {
            maxOutputBytes: LSOF_MAX_OUTPUT_BYTES,
            timeoutMs: LSOF_TIMEOUT_MS,
          })
        : await options.runLsof(target, args);
    if (result.stderr !== "") {
      return {
        status: "unknown",
        reason: `lsof reported an incomplete scan: ${result.stderr.trim()}`,
      };
    }
    return { status: "complete", records: parseLsofFileRecords(result.stdout) };
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
      return { status: "complete", records: [] };
    }
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function ownershipFromLsofInspection(
  target: string,
  inspection: LsofInspection,
): ProcessOwnershipResult {
  if (inspection.status === "unknown") {
    return { status: "unknown", matches: [], reason: inspection.reason };
  }
  const matches: ProcessPathMatch[] = [];
  for (const record of inspection.records) {
    matches.push({
      pid: record.pid,
      source: record.descriptor === "cwd" ? "cwd" : "fd",
      path: record.path ?? target,
    });
  }
  return matches.length > 0 ? { status: "busy", matches } : { status: "idle", matches: [] };
}

export function createProcessOwnershipProbe(
  options: ProcessOwnershipOptions = {},
): (target: string) => Promise<ProcessOwnershipResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return (target) => findProcessesUsingPath(target, options);
  }
  let unavailable: Extract<ProcessOwnershipResult, { status: "unknown" }> | undefined;
  return async (target) => {
    if (unavailable !== undefined) {
      return unavailable;
    }
    const result = await findProcessesUsingPath(target, options);
    if (result.status === "unknown") {
      unavailable = result;
    }
    return result;
  };
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

export async function findProcessesUsingFile(
  target: string,
  options: ProcessOwnershipOptions = {},
): Promise<ProcessOwnershipResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    return inspectLinux(resolve(target), options);
  }
  if (platform === "darwin") {
    return inspectWithLsof(resolve(target), options, true);
  }
  return {
    status: "unknown",
    matches: [],
    reason: `process ownership is unsupported on ${platform}`,
  };
}
