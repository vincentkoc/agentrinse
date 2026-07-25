import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

import type { ProviderFileIdentity, ProviderMutationId } from "../contracts/action.js";
import { sha256Json } from "./digest.js";
import { openPinnedProviderFile, type PinnedFile } from "./pinned-file.js";

async function hashFileDescriptor(handle: PinnedFile, measuredBytes: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < measuredBytes) {
    const remaining = measuredBytes - position;
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, remaining),
      position,
    );
    if (bytesRead === 0) {
      throw new Error("provider file reached end-of-file before its measured size");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function stableFileStats(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.nlink === after.nlink &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.size === after.size
  );
}

export async function inspectProviderFile<T extends ProviderMutationId>(
  path: string,
  ownerRoot: string,
  provider: T,
): Promise<ProviderFileIdentity & { provider: T }> {
  const handle = await openPinnedProviderFile(path, ownerRoot);
  let after: Stats;
  let contentSha256: string;
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`provider cleanup target is not a regular file: ${path}`);
    }
    if (before.nlink !== 1) {
      throw new Error(`provider cleanup target has multiple hard links: ${path}`);
    }
    contentSha256 = await hashFileDescriptor(handle, before.size);
    after = await handle.stat();
    if (!stableFileStats(before, after)) {
      throw new Error(`provider file changed while its content identity was measured: ${path}`);
    }
    if (after.nlink !== 1) {
      throw new Error(`provider cleanup target has multiple hard links: ${path}`);
    }
  } finally {
    await handle.close();
  }

  const identity = {
    path: handle.path,
    ownerRoot: handle.ownerRoot,
    relativePath: handle.relativePath,
    provider,
    device: after.dev,
    inode: after.ino,
    linkCount: 1 as const,
    mode: after.mode,
    mtimeMs: after.mtimeMs,
    measuredBytes: after.size,
    contentSha256,
  };
  return {
    ...identity,
    fingerprint: sha256Json(identity),
  };
}

function modeMatches(actual: number, expected: number, allowSealedMode: boolean): boolean {
  return actual === expected || (allowSealedMode && actual === (expected & ~0o222));
}

export function providerFileIdentityMatches(
  actual: ProviderFileIdentity,
  expected: ProviderFileIdentity,
  allowSealedMode = false,
): boolean {
  return (
    actual.path === expected.path &&
    actual.ownerRoot === expected.ownerRoot &&
    actual.relativePath === expected.relativePath &&
    actual.provider === expected.provider &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.linkCount === expected.linkCount &&
    modeMatches(actual.mode, expected.mode, allowSealedMode) &&
    actual.mtimeMs === expected.mtimeMs &&
    actual.measuredBytes === expected.measuredBytes &&
    actual.contentSha256 === expected.contentSha256 &&
    (actual.fingerprint === expected.fingerprint ||
      (allowSealedMode &&
        actual.fingerprint ===
          sha256Json({
            path: expected.path,
            ownerRoot: expected.ownerRoot,
            relativePath: expected.relativePath,
            provider: expected.provider,
            device: expected.device,
            inode: expected.inode,
            linkCount: expected.linkCount,
            mode: expected.mode & ~0o222,
            mtimeMs: expected.mtimeMs,
            measuredBytes: expected.measuredBytes,
            contentSha256: expected.contentSha256,
          })))
  );
}

export function providerFileStatsMatch(
  stats: Stats,
  expected: ProviderFileIdentity,
  allowSealedMode = false,
): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.dev === expected.device &&
    stats.ino === expected.inode &&
    stats.nlink === expected.linkCount &&
    (stats.mode === expected.mode ||
      (allowSealedMode && stats.mode === (expected.mode & ~0o222))) &&
    stats.mtimeMs === expected.mtimeMs &&
    stats.size === expected.measuredBytes
  );
}
