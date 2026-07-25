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
  handles?: ReadonlyMap<string, FileHandle>;
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

type HeldFile = {
  handle: FileHandle;
  initialMode: number;
  restoreMode: number;
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

async function releaseHandles(
  files: HeldFile[],
  nativeLock: NativeLock,
  restoreInitialModes = false,
): Promise<void> {
  let firstError: unknown;
  // Keep every inode read-only until all record locks are released. Restoring
  // write bits first would let a new opener wait on the old inode at unlock.
  for (const file of files.reverse()) {
    nativeLock.unlock(file.handle.fd);
  }
  for (const file of files) {
    try {
      await file.handle.chmod((restoreInitialModes ? file.initialMode : file.restoreMode) & 0o7777);
    } catch (error) {
      firstError ??= error;
    }
    try {
      await file.handle.close();
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
  restoreModes: ReadonlyMap<string, number> = new Map(),
): Promise<DatabaseExclusion> {
  let nativeLockPromise = nativeLockPromises.get(platform);
  if (nativeLockPromise === undefined) {
    nativeLockPromise = loadNativeLock(platform);
    nativeLockPromises.set(platform, nativeLockPromise);
  }
  const nativeLock = await nativeLockPromise;
  const files: HeldFile[] = [];
  const identities = new Map<string, LockedFileIdentity>();
  const handles = new Map<string, FileHandle>();

  try {
    for (const path of [...new Set(paths)].sort()) {
      const inspectionHandle = await open(path, "r");
      const initialStats = await inspectionHandle.stat();
      const restoreMode = restoreModes.get(path) ?? initialStats.mode;
      if ((initialStats.mode & 0o200) === 0 && (restoreMode & 0o200) !== 0) {
        await inspectionHandle.chmod(restoreMode & 0o7777);
      }
      let handle: FileHandle;
      try {
        handle = await open(path, "r+");
      } catch (error) {
        await inspectionHandle.chmod(initialStats.mode & 0o7777);
        await inspectionHandle.close();
        throw error;
      }
      await inspectionHandle.close();
      const file = { handle, initialMode: initialStats.mode, restoreMode };
      files.push(file);
      handles.set(path, handle);
      const locked = nativeLock.lock(handle.fd);
      if (locked.result !== 0) {
        throw lockError(path, nativeLock.errnoNames, locked.errno);
      }
      const stats = await handle.stat();
      await handle.chmod(stats.mode & ~0o222);
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
    await releaseHandles(files, nativeLock, true).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    identities,
    handles,
    async release() {
      if (released) {
        return;
      }
      released = true;
      await releaseHandles(files, nativeLock);
    },
  };
}
