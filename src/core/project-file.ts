import { lstat } from "node:fs/promises";
import { parse } from "node:path";
import type { Stats } from "node:fs";

import { openPinnedProviderFile } from "./pinned-file.js";

function sameFile(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

// Open each path component without following links. Only read regular files on the expected device.
export async function readProjectFile(
  path: string,
  device: number,
  limit: { prefixBytes: number } | { maxBytes: number },
): Promise<Buffer | undefined> {
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.dev !== device ||
      ("maxBytes" in limit && before.size > limit.maxBytes)
    )
      return;
    const file = await openPinnedProviderFile(path, parse(path).root);
    try {
      if (!sameFile(before, await file.stat())) return;
      const buffer = Buffer.alloc(
        "prefixBytes" in limit ? Math.min(limit.prefixBytes, before.size) : before.size,
      );
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) return;
        offset += bytesRead;
      }
      if (sameFile(before, await file.stat()) && sameFile(before, await lstat(path))) return buffer;
    } finally {
      await file.close();
    }
  } catch {
    // Missing, inaccessible, unsupported, or replaced evidence cannot establish ownership.
  }
  return undefined;
}
