import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { syncDirectory } from "./json-file.js";

export class LockHeldError extends Error {
  override readonly name = "LockHeldError";
}

export type StateLock = {
  path: string;
  release(): Promise<void>;
};

type LockOwner = {
  token: string;
  pid: number;
  hostname: string;
  planId: string;
  createdAt: string;
};

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "token" in value &&
      typeof value.token === "string" &&
      "pid" in value &&
      typeof value.pid === "number" &&
      "hostname" in value &&
      typeof value.hostname === "string" &&
      "planId" in value &&
      typeof value.planId === "string" &&
      "createdAt" in value &&
      typeof value.createdAt === "string"
    ) {
      return value as LockOwner;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function acquireApplyLock(locksDirectory: string, planId: string): Promise<StateLock> {
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, "apply.lock");
  const token = randomUUID();

  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new LockHeldError(
        `apply lock exists at ${path}; verify its recorded process before removing a stale lock`,
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({
        token,
        pid: process.pid,
        hostname: hostname(),
        planId,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await handle.sync();
    await syncDirectory(locksDirectory);
    const identity = await handle.stat();

    let released = false;
    return {
      path,
      async release() {
        if (released) {
          return;
        }
        released = true;
        await handle.close();

        try {
          const [owner, current] = await Promise.all([readOwner(path), lstat(path)]);
          if (
            owner?.token === token &&
            current.dev === identity.dev &&
            current.ino === identity.ino
          ) {
            await rm(path);
            await syncDirectory(locksDirectory);
          }
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            )
          ) {
            throw error;
          }
        }
      },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}
