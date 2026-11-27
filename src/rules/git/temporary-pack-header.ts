import { fstat, type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, parse } from "node:path";
import { promisify } from "node:util";

import { openPinnedProviderFile } from "../../core/pinned-file.js";
import {
  sameFileObservation,
  sameObservation,
  type EntryBudget,
} from "../../core/storage-observation.js";

const statFd = promisify(fstat);
const headerSize = 12;
export const packHeaderReadLimit = 4096;

export function packHeaderCounts() {
  return { empty: 0, headerOnly: 0, unknown: 0, withheld: 0, readLimitSkipped: 0 };
}

function sameFile(expected: BigIntStats, observed: BigIntStats) {
  return (
    observed.isFile() &&
    observed.nlink === 1n &&
    observed.uid === expected.uid &&
    observed.gid === expected.gid &&
    sameFileObservation(expected, observed)
  );
}

// A zero-length name has no bytes. Larger or shorter files stay opaque. Only
// an exact header-length file needs an open, so this probe never reads a body.
export async function observePackHeader(
  path: string,
  expected: BigIntStats,
  directory: BigIntStats,
  budget: EntryBudget,
): Promise<keyof ReturnType<typeof packHeaderCounts>> {
  if (
    !expected.isFile() ||
    expected.nlink !== 1n ||
    expected.dev !== directory.dev ||
    process.getuid?.() !== Number(expected.uid)
  )
    return "withheld";
  if (expected.size === 0n) return "empty";
  if (expected.size !== BigInt(headerSize)) return "unknown";
  if (budget.remaining === 0) return "readLimitSkipped";
  budget.remaining--;
  try {
    const file = await openPinnedProviderFile(path, parse(path).root);
    try {
      const parent = await statFd(file.parent.fd, { bigint: true });
      if (
        !sameObservation(directory, parent) ||
        !sameFile(expected, await statFd(file.fd, { bigint: true }))
      )
        return "withheld";
      const header = Buffer.alloc(headerSize);
      const { bytesRead } = await file.read(header, 0, headerSize, 0);
      if (
        bytesRead !== headerSize ||
        !sameFile(expected, await statFd(file.fd, { bigint: true })) ||
        !sameFile(expected, await lstat(path, { bigint: true })) ||
        !sameObservation(parent, await lstat(dirname(path), { bigint: true }))
      )
        return "withheld";
      const version = header.readUInt32BE(4);
      return header.readUInt32BE(0) === 0x5041434b && (version === 2 || version === 3)
        ? "headerOnly"
        : "unknown";
    } finally {
      await file.close();
    }
  } catch {
    return "withheld";
  }
}
