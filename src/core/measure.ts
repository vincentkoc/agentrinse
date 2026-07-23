import { createHash } from "node:crypto";
import { lstat, opendir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

export type Measurement = {
  bytes: number;
  entries: number;
  symlinksSkipped: number;
  truncated: boolean;
  newestMtimeMs: number;
  fingerprint: string;
};

export type MeasureOptions = {
  maxEntries: number;
  signal?: AbortSignal;
};

export async function measurePath(root: string, options: MeasureOptions): Promise<Measurement> {
  const result: Measurement = {
    bytes: 0,
    entries: 0,
    symlinksSkipped: 0,
    truncated: false,
    newestMtimeMs: 0,
    fingerprint: "",
  };

  const pending = [root];
  const fingerprint = createHash("sha256");

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

    const stats = await lstat(path);
    result.entries += 1;
    result.newestMtimeMs = Math.max(result.newestMtimeMs, stats.mtimeMs);
    const identity = {
      path: relative(root, path),
      device: stats.dev,
      inode: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      type: stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : "file",
      ...(stats.isSymbolicLink() ? { link: await readlink(path) } : {}),
    };
    fingerprint.update(`${JSON.stringify(identity)}\n`);

    if (stats.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      continue;
    }

    if (!stats.isDirectory()) {
      result.bytes += stats.size;
      continue;
    }

    const directory = await opendir(path);
    const names: string[] = [];
    for await (const entry of directory) {
      names.push(entry.name);
    }
    names.sort((left, right) => right.localeCompare(left));
    for (const name of names) {
      pending.push(join(path, name));
    }
  }

  result.fingerprint = fingerprint.digest("hex");
  return result;
}
