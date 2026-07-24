type NativeRename = (
  source: string,
  destination: string,
) => {
  result: number;
  errno: number;
  errnoNames: Record<string, number>;
};

const nativeRenamePromises = new Map<NodeJS.Platform, Promise<NativeRename>>();

function errnoName(errnoNames: Record<string, number>, value: number): string {
  return Object.entries(errnoNames).find(([, errno]) => errno === value)?.[0] ?? "EIO";
}

function renameError(
  source: string,
  destination: string,
  errnoNames: Record<string, number>,
  errno: number,
): NodeJS.ErrnoException {
  const code = errnoName(errnoNames, errno);
  const error = new Error(
    `atomic no-replace rename failed from ${source} to ${destination}: ${code}`,
  ) as NodeJS.ErrnoException & { dest?: string };
  error.code = code;
  error.errno = errno;
  error.path = source;
  error.dest = destination;
  error.syscall = "rename";
  return error;
}

async function loadNativeRename(platform: NodeJS.Platform): Promise<NativeRename> {
  if (!["darwin", "linux"].includes(platform)) {
    const error = new Error(
      `atomic no-replace rename is unsupported on ${platform}`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOTSUP";
    throw error;
  }

  const { default: koffi } = await import("koffi");
  const libc = koffi.load(null);
  if (platform === "darwin") {
    const renameExclusive = libc.func(
      "int renamex_np(const char *source, const char *destination, unsigned int flags)",
    );
    return (source, destination) => ({
      result: renameExclusive(source, destination, 0x0000_0004) as number,
      errno: koffi.errno(),
      errnoNames: koffi.os.errno,
    });
  }

  let renameNoReplace: ReturnType<typeof libc.func>;
  try {
    renameNoReplace = libc.func(
      "int renameat2(int olddirfd, const char *source, int newdirfd, const char *destination, unsigned int flags)",
    );
  } catch (error) {
    const unsupported = new Error(
      "the Linux C library does not expose renameat2 for atomic no-replace moves",
      { cause: error },
    ) as NodeJS.ErrnoException;
    unsupported.code = "ENOTSUP";
    throw unsupported;
  }
  return (source, destination) => ({
    result: renameNoReplace(-100, source, -100, destination, 0x0000_0001) as number,
    errno: koffi.errno(),
    errnoNames: koffi.os.errno,
  });
}

export async function renameNoReplace(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let nativeRenamePromise = nativeRenamePromises.get(platform);
  if (nativeRenamePromise === undefined) {
    nativeRenamePromise = loadNativeRename(platform);
    nativeRenamePromises.set(platform, nativeRenamePromise);
  }
  const nativeRename = await nativeRenamePromise;
  const result = nativeRename(source, destination);
  if (result.result !== 0) {
    throw renameError(source, destination, result.errnoNames, result.errno);
  }
}
