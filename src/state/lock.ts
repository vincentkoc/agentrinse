import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import {
  inspectProcessIdentity,
  type ProcessIdentityInspection,
} from "../core/process-identity.js";
import { syncDirectory } from "./json-file.js";

export class LockHeldError extends Error {
  override readonly name = "LockHeldError";
}

export class LockRecoveryError extends Error {
  override readonly name = "LockRecoveryError";
}

export type StateLock = {
  path: string;
  release(): Promise<void>;
};

export type ApplyLockOwner = {
  token: string;
  pid: number;
  processStartIdentity?: string;
  hostname: string;
  command: string;
  planId: string;
  runId: string;
  createdAt: string;
};

export type ApplyLockStatus =
  | { status: "absent"; path: string }
  | { status: "malformed"; path: string; reason: string }
  | { status: "active"; path: string; owner: ApplyLockOwner }
  | { status: "stale"; path: string; owner: ApplyLockOwner; reason: string }
  | { status: "remote"; path: string; owner: ApplyLockOwner; reason: string }
  | { status: "unknown"; path: string; owner: ApplyLockOwner; reason: string };

export type AcquireApplyLockOptions = {
  planId: string;
  runId: string;
  command: string;
};

export type LockInspectionDependencies = {
  currentHostname?: () => string;
  inspectProcess?: (pid: number) => Promise<ProcessIdentityInspection>;
  beforeRecoveryRemove?: () => Promise<void>;
};

type LockSnapshot = {
  status: ApplyLockStatus;
  identity?: Pick<Stats, "dev" | "ino">;
};

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function parseOwner(value: unknown): ApplyLockOwner | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("hostname" in value) ||
    typeof value.hostname !== "string" ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    !("planId" in value) ||
    typeof value.planId !== "string" ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    ("processStartIdentity" in value &&
      value.processStartIdentity !== undefined &&
      typeof value.processStartIdentity !== "string")
  ) {
    return undefined;
  }
  return value as ApplyLockOwner;
}

async function readOwner(path: string): Promise<ApplyLockOwner | undefined> {
  try {
    return parseOwner(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

async function acquireRecoveryMutex(locksDirectory: string): Promise<StateLock> {
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, "apply.recovery.lock");
  const token = randomUUID();
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new LockRecoveryError("apply lock recovery is already in progress");
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid })}\n`, "utf8");
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
          const [raw, current] = await Promise.all([readFile(path, "utf8"), lstat(path)]);
          const record = JSON.parse(raw) as { token?: unknown };
          if (
            record.token === token &&
            current.dev === identity.dev &&
            current.ino === identity.ino
          ) {
            await rm(path);
            await syncDirectory(locksDirectory);
          }
        } catch (error) {
          if (!isErrno(error, "ENOENT")) {
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

async function inspectLockSnapshot(
  locksDirectory: string,
  dependencies: LockInspectionDependencies = {},
): Promise<LockSnapshot> {
  const path = join(locksDirectory, "apply.lock");
  let raw: string;
  let identity: Stats;
  try {
    [raw, identity] = await Promise.all([readFile(path, "utf8"), lstat(path)]);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { status: { status: "absent", path } };
    }
    throw error;
  }

  let owner: ApplyLockOwner | undefined;
  try {
    owner = parseOwner(JSON.parse(raw) as unknown);
  } catch {
    owner = undefined;
  }
  if (owner === undefined) {
    return {
      status: { status: "malformed", path, reason: "lock record is not valid AgentRinse JSON" },
      identity,
    };
  }

  const localHostname = (dependencies.currentHostname ?? hostname)();
  if (owner.hostname !== localHostname) {
    return {
      status: {
        status: "remote",
        path,
        owner,
        reason: `lock belongs to host ${owner.hostname}; local host is ${localHostname}`,
      },
      identity,
    };
  }

  const processIdentity = await (dependencies.inspectProcess ?? inspectProcessIdentity)(owner.pid);
  if (processIdentity.status === "dead") {
    return {
      status: {
        status: "stale",
        path,
        owner,
        reason: `recorded process ${owner.pid} no longer exists`,
      },
      identity,
    };
  }
  if (processIdentity.status === "unknown") {
    return {
      status: {
        status: "unknown",
        path,
        owner,
        reason: processIdentity.reason,
      },
      identity,
    };
  }
  if (owner.processStartIdentity === undefined) {
    return {
      status: {
        status: "unknown",
        path,
        owner,
        reason: `lock has no process start identity for live PID ${owner.pid}`,
      },
      identity,
    };
  }
  if (owner.processStartIdentity !== processIdentity.identity) {
    return {
      status: {
        status: "stale",
        path,
        owner,
        reason: `PID ${owner.pid} was reused by a different process`,
      },
      identity,
    };
  }
  return { status: { status: "active", path, owner }, identity };
}

export async function inspectApplyLock(
  locksDirectory: string,
  dependencies: LockInspectionDependencies = {},
): Promise<ApplyLockStatus> {
  return (await inspectLockSnapshot(locksDirectory, dependencies)).status;
}

export async function recoverStaleApplyLock(
  locksDirectory: string,
  dependencies: LockInspectionDependencies = {},
): Promise<ApplyLockOwner> {
  const recoveryMutex = await acquireRecoveryMutex(locksDirectory);
  try {
    const snapshot = await inspectLockSnapshot(locksDirectory, dependencies);
    if (snapshot.status.status !== "stale" || snapshot.identity === undefined) {
      throw new LockRecoveryError(
        `apply lock is ${snapshot.status.status}; recovery requires a proven stale local owner`,
      );
    }

    await dependencies.beforeRecoveryRemove?.();
    const [owner, current] = await Promise.all([
      readOwner(snapshot.status.path),
      lstat(snapshot.status.path),
    ]).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) {
        throw new LockRecoveryError("apply lock changed before recovery");
      }
      throw error;
    });
    if (
      owner?.token !== snapshot.status.owner.token ||
      current.dev !== snapshot.identity.dev ||
      current.ino !== snapshot.identity.ino
    ) {
      throw new LockRecoveryError("apply lock changed before recovery");
    }

    await rm(snapshot.status.path);
    await syncDirectory(locksDirectory);
    return snapshot.status.owner;
  } finally {
    await recoveryMutex.release();
  }
}

export async function acquireApplyLock(
  locksDirectory: string,
  options: AcquireApplyLockOptions,
): Promise<StateLock> {
  await mkdir(locksDirectory, { recursive: true, mode: 0o700 });
  const path = join(locksDirectory, "apply.lock");
  const token = randomUUID();
  const processIdentity = await inspectProcessIdentity(process.pid);
  const owner: ApplyLockOwner = {
    token,
    pid: process.pid,
    ...(processIdentity.status === "alive"
      ? { processStartIdentity: processIdentity.identity }
      : {}),
    hostname: hostname(),
    command: options.command,
    planId: options.planId,
    runId: options.runId,
    createdAt: new Date().toISOString(),
  };

  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new LockHeldError(
        `apply lock exists at ${path}; inspect it with "agentrinse lock status"`,
      );
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
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
          const [currentOwner, current] = await Promise.all([readOwner(path), lstat(path)]);
          if (
            currentOwner?.token === token &&
            current.dev === identity.dev &&
            current.ino === identity.ino
          ) {
            await rm(path);
            await syncDirectory(locksDirectory);
          }
        } catch (error) {
          if (!isErrno(error, "ENOENT")) {
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
