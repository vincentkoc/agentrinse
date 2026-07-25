import { open, type FileHandle } from "node:fs/promises";

export type LockedFileIdentity = {
  path: string;
  device: number;
  inode: number;
  mode: number;
  mtimeMs: number;
  measuredBytes: number;
};

export type DatabaseExclusion = {
  identities: Map<string, LockedFileIdentity>;
  release: () => Promise<void>;
};

export function lockedFileIdentityMatches(
  actual: LockedFileIdentity | undefined,
  expected: {
    device: number;
    inode: number;
    mode: number;
    mtimeMs: number;
    measuredBytes: number;
  },
): boolean {
  return (
    actual !== undefined &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.mode === expected.mode &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.measuredBytes === expected.measuredBytes
  );
}

type NativeLock = {
  lock: (fileDescriptor: number) => { result: number; errno: number };
  unlock: (fileDescriptor: number) => { result: number; errno: number };
  errnoNames: Record<string, number>;
};

const nativeLockPromises = new Map<NodeJS.Platform, Promise<NativeLock>>();

function errnoName(errnoNames: Record<string, number>, value: number): string {
  return Object.entries(errnoNames).find(([, errno]) => errno === value)?.[0] ?? "EIO";
}

function lockError(
  path: string,
  errnoNames: Record<string, number>,
  errno: number,
): NodeJS.ErrnoException {
  const code = errnoName(errnoNames, errno);
  const error = new Error(`could not hold exclusive SQLite access for ${path}: ${code}`) as
    | NodeJS.ErrnoException
    | Error;
  (error as NodeJS.ErrnoException).code = code;
  (error as NodeJS.ErrnoException).errno = errno;
  (error as NodeJS.ErrnoException).path = path;
  (error as NodeJS.ErrnoException).syscall = "lockf";
  return error;
}

async function loadNativeLock(platform: NodeJS.Platform): Promise<NativeLock> {
  if (!["darwin", "linux"].includes(platform)) {
    const error = new Error(
      `exclusive SQLite file locking is unsupported on ${platform}`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOTSUP";
    throw error;
  }

  const { default: koffi } = await import("koffi");
  const libc = koffi.load(null);
  const lockf = libc.func("int lockf(int fd, int function, int64 length)");
  return {
    lock: (fileDescriptor) => ({
      result: lockf(fileDescriptor, 2, 0) as number,
      errno: koffi.errno(),
    }),
    unlock: (fileDescriptor) => ({
      result: lockf(fileDescriptor, 0, 0) as number,
      errno: koffi.errno(),
    }),
    errnoNames: koffi.os.errno,
  };
}

async function releaseHandles(handles: FileHandle[], nativeLock: NativeLock): Promise<void> {
  let firstError: unknown;
  for (const handle of handles.reverse()) {
    nativeLock.unlock(handle.fd);
    try {
      await handle.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function acquireDatabaseExclusion(
  paths: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<DatabaseExclusion> {
  let nativeLockPromise = nativeLockPromises.get(platform);
  if (nativeLockPromise === undefined) {
    nativeLockPromise = loadNativeLock(platform);
    nativeLockPromises.set(platform, nativeLockPromise);
  }
  const nativeLock = await nativeLockPromise;
  const handles: FileHandle[] = [];
  const identities = new Map<string, LockedFileIdentity>();

  try {
    for (const path of [...new Set(paths)].sort()) {
      const handle = await open(path, "r+");
      handles.push(handle);
      const locked = nativeLock.lock(handle.fd);
      if (locked.result !== 0) {
        throw lockError(path, nativeLock.errnoNames, locked.errno);
      }
      const stats = await handle.stat();
      identities.set(path, {
        path,
        device: stats.dev,
        inode: stats.ino,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
        measuredBytes: stats.size,
      });
    }
  } catch (error) {
    await releaseHandles(handles, nativeLock).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    identities,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await releaseHandles(handles, nativeLock);
    },
  };
}
