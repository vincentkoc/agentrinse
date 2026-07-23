import { mkdir, open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export class LockHeldError extends Error {
  override readonly name = "LockHeldError";
}

export type StateLock = {
  path: string;
  release(): Promise<void>;
};

export async function acquireApplyLock(
  locksDirectory: string,
  planId: string,
): Promise<StateLock> {
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, "apply.lock");

  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new LockHeldError(
        `another AgentRinse apply run owns ${path}`,
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        planId,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    path,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await handle.close();
      await rm(path, { force: true });
    },
  };
}
