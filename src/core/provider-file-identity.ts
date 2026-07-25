import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ProviderFileIdentity, ProviderMutationId } from "../contracts/action.js";
import { sha256Json } from "./digest.js";

function inside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result !== "" && !result.startsWith("..") && !isAbsolute(result);
}

async function hashFileDescriptor(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function assertNoSymlinkBelowRoot(path: string, ownerRoot: string): Promise<void> {
  const lexicalRoot = resolve(ownerRoot);
  const lexicalPath = resolve(path);
  if (!inside(lexicalRoot, lexicalPath)) {
    throw new Error(`provider file is outside its owner root: ${path}`);
  }
  const components = relative(lexicalRoot, lexicalPath).split(/[\\/]/u);
  let cursor = lexicalRoot;
  for (const component of components) {
    cursor = join(cursor, component);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new Error(`provider cleanup path contains a symlink: ${cursor}`);
    }
  }
}

function stableFileStats(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
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

function sameFileStats(
  pathStats: Awaited<ReturnType<typeof lstat>>,
  descriptorStats: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    pathStats.isFile() &&
    !pathStats.isSymbolicLink() &&
    pathStats.dev === descriptorStats.dev &&
    pathStats.ino === descriptorStats.ino &&
    pathStats.nlink === descriptorStats.nlink &&
    pathStats.mode === descriptorStats.mode &&
    pathStats.mtimeMs === descriptorStats.mtimeMs &&
    pathStats.ctimeMs === descriptorStats.ctimeMs &&
    pathStats.size === descriptorStats.size
  );
}

export async function inspectProviderFile(
  path: string,
  ownerRoot: string,
  provider: ProviderMutationId,
): Promise<ProviderFileIdentity> {
  await assertNoSymlinkBelowRoot(path, ownerRoot);
  const [physicalRoot, physicalPath] = await Promise.all([
    realpath(resolve(ownerRoot)),
    realpath(resolve(path)),
  ]);
  const rootStats = await lstat(physicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`provider owner root is not a real directory: ${ownerRoot}`);
  }
  if (!inside(physicalRoot, physicalPath)) {
    throw new Error(`provider file is outside its owner root: ${path}`);
  }

  const handle = await open(physicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let after: Awaited<ReturnType<typeof lstat>>;
  let contentSha256: string;
  try {
    const before = await handle.stat();
    const pathBefore = await lstat(physicalPath);
    if (!sameFileStats(pathBefore, before)) {
      throw new Error(`provider file changed while its descriptor was acquired: ${path}`);
    }
    if (before.nlink !== 1) {
      throw new Error(`provider cleanup target has multiple hard links: ${path}`);
    }
    contentSha256 = await hashFileDescriptor(handle);
    after = await handle.stat();
    const pathAfter = await lstat(physicalPath);
    if (!stableFileStats(before, after) || !sameFileStats(pathAfter, after)) {
      throw new Error(`provider file changed while its content identity was measured: ${path}`);
    }
    if (after.nlink !== 1) {
      throw new Error(`provider cleanup target has multiple hard links: ${path}`);
    }
  } finally {
    await handle.close();
  }

  const identity = {
    path: physicalPath,
    ownerRoot: physicalRoot,
    relativePath: relative(physicalRoot, physicalPath),
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
  stats: Awaited<ReturnType<typeof lstat>>,
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
