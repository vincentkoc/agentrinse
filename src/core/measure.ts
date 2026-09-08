import { createHash } from "node:crypto";
import { lstat, opendir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Stats } from "node:fs";

export type Measurement = {
  bytes: number;
  entries: number;
  symlinksSkipped: number;
  specialEntries: number;
  truncated: boolean;
  newestMtimeMs: number;
  fingerprint: string;
  mountBoundaries: number;
};

export type MeasureOptions = {
  maxEntries: number;
  signal?: AbortSignal;
  excludeRootEntries?: string[];
};

type DirectoryEntry = {
  name: string;
};

type DirectoryReader = {
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncIterableIterator<DirectoryEntry>;
};

export type MeasureDependencies = {
  inspect?: (path: string) => Promise<Stats>;
  openDirectory?: (path: string) => Promise<DirectoryReader>;
  readLink?: (path: string) => Promise<string>;
};

async function closeDirectory(directory: DirectoryReader): Promise<void> {
  try {
    await directory.close();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ERR_DIR_CLOSED")) {
      throw error;
    }
  }
}

export async function measurePath(
  root: string,
  options: MeasureOptions,
  dependencies: MeasureDependencies = {},
): Promise<Measurement> {
  if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
    throw new Error("measurePath maxEntries must be a positive integer");
  }

  const inspect = dependencies.inspect ?? lstat;
  const openDirectory = dependencies.openDirectory ?? opendir;
  const readLink = dependencies.readLink ?? readlink;
  const result: Measurement = {
    bytes: 0,
    entries: 0,
    symlinksSkipped: 0,
    specialEntries: 0,
    truncated: false,
    newestMtimeMs: 0,
    fingerprint: "",
    mountBoundaries: 0,
  };

  const pending = [root];
  const fingerprint = createHash("sha256");
  let rootDevice: number | undefined;
  let excludedEntriesRead = 0;

  while (pending.length > 0) {
    options.signal?.throwIfAborted();

    const path = pending.pop();
    if (path === undefined) {
      break;
    }

    if (result.entries >= options.maxEntries) {
      result.truncated = true;
      break;
    }

    const stats = await inspect(path);
    rootDevice ??= stats.dev;
    result.entries += 1;
    result.newestMtimeMs = Math.max(result.newestMtimeMs, stats.mtimeMs);
    const identity = {
      path: relative(root, path),
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ...(path === root ? {} : { ctimeMs: stats.ctimeMs }),
      type: stats.isSymbolicLink()
        ? "symlink"
        : stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : "special",
      ...(stats.isSymbolicLink() ? { link: await readLink(path) } : {}),
    };
    fingerprint.update(`${JSON.stringify(identity)}\n`);

    if (path !== root && stats.dev !== rootDevice) {
      result.mountBoundaries += 1;
      continue;
    }

    if (stats.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      continue;
    }

    if (stats.isFile()) {
      result.bytes += stats.size;
      continue;
    }

    if (!stats.isDirectory()) {
      result.specialEntries += 1;
      continue;
    }

    const directory = await openDirectory(path);
    const names: string[] = [];
    try {
      for await (const entry of directory) {
        options.signal?.throwIfAborted();
        if (
          result.entries + pending.length + names.length + excludedEntriesRead >=
          options.maxEntries
        ) {
          result.truncated = true;
          break;
        }
        if (path === root && options.excludeRootEntries?.includes(entry.name) === true) {
          excludedEntriesRead += 1;
          continue;
        }
        names.push(entry.name);
      }
    } finally {
      await closeDirectory(directory);
    }
    names.sort((left, right) => right.localeCompare(left));
    for (const name of names) {
      pending.push(join(path, name));
    }
  }

  result.fingerprint = fingerprint.digest("hex");
  return result;
}
