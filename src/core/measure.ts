import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

export type Measurement = {
  bytes: number;
  entries: number;
  symlinksSkipped: number;
  truncated: boolean;
};

export type MeasureOptions = {
  maxEntries: number;
  signal?: AbortSignal;
};

export async function measurePath(
  root: string,
  options: MeasureOptions,
): Promise<Measurement> {
  const result: Measurement = {
    bytes: 0,
    entries: 0,
    symlinksSkipped: 0,
    truncated: false,
  };

  const pending = [root];

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

    if (stats.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      continue;
    }

    if (!stats.isDirectory()) {
      result.bytes += stats.size;
      continue;
    }

    const directory = await opendir(path);
    for await (const entry of directory) {
      pending.push(join(path, entry.name));
    }
  }

  return result;
}

