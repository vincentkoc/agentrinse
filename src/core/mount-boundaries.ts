import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { isPathInside } from "./safety.js";

const execFileAsync = promisify(execFile);

export type MountBoundaryResult =
  | { status: "clear"; paths: [] }
  | { status: "blocked"; paths: string[] }
  | { status: "unknown"; paths: []; reason: string };

export type MountBoundaryOptions = {
  platform?: NodeJS.Platform;
  linuxMountInfo?: string;
  runMount?: () => Promise<{ stdout: string; stderr: string }>;
};

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function linuxMountPaths(input: string): string[] {
  return input
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" ")[4])
    .filter((path): path is string => path !== undefined)
    .map(decodeMountPath);
}

function darwinMountPaths(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.match(/ on (.+) \(/)?.[1])
    .filter((path): path is string => path !== undefined)
    .map(decodeMountPath);
}

export async function findMountBoundaries(
  target: string,
  options: MountBoundaryOptions = {},
): Promise<MountBoundaryResult> {
  const platform = options.platform ?? process.platform;

  try {
    const physicalTarget = await realpath(resolve(target));
    let mountPaths: string[];

    if (platform === "linux") {
      const input = options.linuxMountInfo ?? (await readFile("/proc/self/mountinfo", "utf8"));
      mountPaths = linuxMountPaths(input);
    } else if (platform === "darwin") {
      const result =
        options.runMount === undefined
          ? await execFileAsync("/sbin/mount", [], {
              encoding: "utf8",
              maxBuffer: 4 * 1024 * 1024,
              timeout: 10_000,
            })
          : await options.runMount();
      if (result.stderr !== "") {
        return {
          status: "unknown",
          paths: [],
          reason: `mount reported an incomplete scan: ${result.stderr.trim()}`,
        };
      }
      mountPaths = darwinMountPaths(result.stdout);
    } else {
      return {
        status: "unknown",
        paths: [],
        reason: `mount inspection is unsupported on ${platform}`,
      };
    }

    const paths = mountPaths
      .map((path) => resolve(path))
      .filter((path) => isPathInside(physicalTarget, path))
      .sort((left, right) => left.localeCompare(right));
    return paths.length === 0 ? { status: "clear", paths: [] } : { status: "blocked", paths };
  } catch (error) {
    return {
      status: "unknown",
      paths: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
