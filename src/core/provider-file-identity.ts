import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ProviderFileIdentity, ProviderMutationId } from "../contracts/action.js";
import { sha256Json } from "./digest.js";

function inside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result !== "" && !result.startsWith("..") && !isAbsolute(result);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function stableFileStats(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs &&
    before.size === after.size
  );
}

export async function inspectProviderFile(
  path: string,
  ownerRoot: string,
  provider: ProviderMutationId,
): Promise<ProviderFileIdentity> {
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

  const before = await lstat(physicalPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`provider cleanup target is not a regular file: ${path}`);
  }
  const contentSha256 = await hashFile(physicalPath);
  const after = await lstat(physicalPath);
  if (!stableFileStats(before, after)) {
    throw new Error(`provider file changed while its content identity was measured: ${path}`);
  }

  const identity = {
    path: physicalPath,
    ownerRoot: physicalRoot,
    relativePath: relative(physicalRoot, physicalPath),
    provider,
    device: after.dev,
    inode: after.ino,
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
            mode: expected.mode & ~0o222,
            mtimeMs: expected.mtimeMs,
            measuredBytes: expected.measuredBytes,
            contentSha256: expected.contentSha256,
          })))
  );
}
