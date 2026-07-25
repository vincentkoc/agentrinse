import {
  close as closeCallback,
  constants,
  fchmod,
  fstat,
  fsync,
  ftruncate,
  read,
  type Stats,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type NativeOpenAt = (
  directoryFd: number,
  path: string,
  flags: number,
) => {
  fd: number;
  errno: number;
  errnoNames: Record<string, number>;
};

let nativeOpenAtPromise: Promise<NativeOpenAt> | undefined;
const O_CLOEXEC = process.platform === "darwin" ? 0x0100_0000 : 0x0008_0000;

function errnoName(errnoNames: Record<string, number>, value: number): string {
  return Object.entries(errnoNames).find(([, errno]) => errno === value)?.[0] ?? "EIO";
}

function nativeError(
  syscall: string,
  path: string,
  errnoNames: Record<string, number>,
  errno: number,
): NodeJS.ErrnoException {
  const code = errnoName(errnoNames, errno);
  const error = new Error(`${syscall} failed for ${path}: ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = errno;
  error.path = path;
  error.syscall = syscall;
  return error;
}

async function loadNativeOpenAt(): Promise<NativeOpenAt> {
  if (!["darwin", "linux"].includes(process.platform)) {
    const error = new Error(`pinned file traversal is unsupported on ${process.platform}`);
    (error as NodeJS.ErrnoException).code = "ENOTSUP";
    throw error;
  }
  const { default: koffi } = await import("koffi");
  const libc = koffi.load(null);
  const openAt = libc.func(
    "int openat(int directoryFd, const char *path, int flags, unsigned int mode)",
  );
  return (directoryFd, path, flags) => ({
    fd: openAt(directoryFd, path, flags, 0) as number,
    errno: koffi.errno(),
    errnoNames: koffi.os.errno,
  });
}

async function openAt(directoryFd: number, path: string, flags: number): Promise<number> {
  nativeOpenAtPromise ??= loadNativeOpenAt();
  const nativeOpenAt = await nativeOpenAtPromise;
  const result = nativeOpenAt(directoryFd, path, flags);
  if (result.fd < 0) {
    throw nativeError("openat", path, result.errnoNames, result.errno);
  }
  return result.fd;
}

function closeFd(fd: number): Promise<void> {
  return new Promise((resolveClose, reject) => {
    closeCallback(fd, (error) => (error === null ? resolveClose() : reject(error)));
  });
}

function statFd(fd: number): Promise<Stats> {
  return new Promise((resolveStat, reject) => {
    fstat(fd, (error, stats) => (error === null ? resolveStat(stats) : reject(error)));
  });
}

function chmodFd(fd: number, mode: number): Promise<void> {
  return new Promise((resolveChmod, reject) => {
    fchmod(fd, mode, (error) => (error === null ? resolveChmod() : reject(error)));
  });
}

function syncFd(fd: number): Promise<void> {
  return new Promise((resolveSync, reject) => {
    fsync(fd, (error) => (error === null ? resolveSync() : reject(error)));
  });
}

function truncateFd(fd: number, length: number): Promise<void> {
  return new Promise((resolveTruncate, reject) => {
    ftruncate(fd, length, (error) => (error === null ? resolveTruncate() : reject(error)));
  });
}

function readFd(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<{ bytesRead: number; buffer: Buffer }> {
  return new Promise((resolveRead, reject) => {
    read(fd, buffer, offset, length, position, (error, bytesRead, readBuffer) =>
      error === null ? resolveRead({ bytesRead, buffer: readBuffer }) : reject(error),
    );
  });
}

function pathComponents(path: string): string[] {
  return path.split(sep).filter((component) => component !== "");
}

async function openPhysicalDirectory(path: string): Promise<number> {
  const physicalPath = await realpath(resolve(path));
  if (!isAbsolute(physicalPath)) {
    throw new Error(`pinned directory path is not absolute: ${path}`);
  }
  let directoryFd = await openAt(
    -100,
    sep,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      O_CLOEXEC,
  );
  try {
    for (const component of pathComponents(physicalPath)) {
      const nextFd = await openAt(
        directoryFd,
        component,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          O_CLOEXEC,
      );
      await closeFd(directoryFd);
      directoryFd = nextFd;
    }
    const stats = await statFd(directoryFd);
    if (!stats.isDirectory()) {
      throw new Error(`pinned directory target is not a directory: ${path}`);
    }
    return directoryFd;
  } catch (error) {
    await closeFd(directoryFd).catch(() => undefined);
    throw error;
  }
}

export class PinnedDirectory {
  private closed = false;

  constructor(
    readonly fd: number,
    readonly path: string,
  ) {}

  stat(): Promise<Stats> {
    return statFd(this.fd);
  }

  sync(): Promise<void> {
    return syncFd(this.fd);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await closeFd(this.fd);
  }
}

export class PinnedFile {
  private closed = false;

  constructor(
    readonly fd: number,
    readonly parent: PinnedDirectory,
    readonly basename: string,
    readonly path: string,
    readonly ownerRoot: string,
    readonly relativePath: string,
  ) {}

  stat(): Promise<Stats> {
    return statFd(this.fd);
  }

  chmod(mode: number): Promise<void> {
    return chmodFd(this.fd, mode);
  }

  sync(): Promise<void> {
    return syncFd(this.fd);
  }

  truncate(length: number): Promise<void> {
    return truncateFd(this.fd, length);
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }> {
    return readFd(this.fd, buffer, offset, length, position);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all([closeFd(this.fd), this.parent.close()]);
  }
}

export async function openPinnedDirectory(path: string): Promise<PinnedDirectory> {
  const physicalPath = await realpath(resolve(path));
  return new PinnedDirectory(await openPhysicalDirectory(physicalPath), physicalPath);
}

export async function openPinnedProviderParent(
  ownerRoot: string,
  relativePath: string,
): Promise<{ parent: PinnedDirectory; basename: string; physicalPath: string }> {
  const physicalRoot = await realpath(resolve(ownerRoot));
  if (isAbsolute(relativePath)) {
    throw new Error(`provider relative path is invalid: ${relativePath}`);
  }
  const components = pathComponents(relativePath);
  if (
    components.length === 0 ||
    components.some((component) => component === "." || component === "..")
  ) {
    throw new Error(`provider relative path is invalid: ${relativePath}`);
  }
  let directoryFd = await openPhysicalDirectory(physicalRoot);
  try {
    for (const component of components.slice(0, -1)) {
      const nextFd = await openAt(
        directoryFd,
        component,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          O_CLOEXEC,
      );
      await closeFd(directoryFd);
      directoryFd = nextFd;
    }
    const basename = components.at(-1)!;
    const parentPath = join(physicalRoot, ...components.slice(0, -1));
    return {
      parent: new PinnedDirectory(directoryFd, parentPath),
      basename,
      physicalPath: join(parentPath, basename),
    };
  } catch (error) {
    await closeFd(directoryFd).catch(() => undefined);
    throw error;
  }
}

export async function openPinnedProviderFile(
  path: string,
  ownerRoot: string,
  flags: number = constants.O_RDONLY,
): Promise<PinnedFile> {
  const lexicalRoot = resolve(ownerRoot);
  const lexicalPath = resolve(path);
  const relativePath = relative(lexicalRoot, lexicalPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`provider file is outside its owner root: ${path}`);
  }
  const physicalRoot = await realpath(lexicalRoot);
  const openedParent = await openPinnedProviderParent(physicalRoot, relativePath);
  try {
    const fd = await openAt(
      openedParent.parent.fd,
      openedParent.basename,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
    );
    return new PinnedFile(
      fd,
      openedParent.parent,
      openedParent.basename,
      openedParent.physicalPath,
      physicalRoot,
      relativePath,
    );
  } catch (error) {
    await openedParent.parent.close().catch(() => undefined);
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new Error(`provider cleanup path contains a symlink: ${path}`, { cause: error });
    }
    throw error;
  }
}
