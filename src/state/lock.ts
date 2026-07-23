import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

async function removeStaleLocalLock(path: string): Promise<boolean> {
  const owner = await readOwner(path);
  if (owner === undefined || owner.hostname !== hostname() || processExists(owner.pid)) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

export async function acquireApplyLock(locksDirectory: string, planId: string): Promise<StateLock> {
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, "apply.lock");
  const token = randomUUID();

  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST" &&
        attempt === 0 &&
        (await removeStaleLocalLock(path))
      ) {
        continue;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw new LockHeldError(`another AgentRinse apply run owns ${path}`);
      }
      throw error;
    }
  }
  if (handle === undefined) {
    throw new LockHeldError(`another AgentRinse apply run owns ${path}`);
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
