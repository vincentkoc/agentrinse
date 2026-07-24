import { homedir, tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";

export class UnsafeAuditRootError extends Error {
  override readonly name = "UnsafeAuditRootError";
}

export class UnsafeDestructiveFixtureError extends Error {
  override readonly name = "UnsafeDestructiveFixtureError";
}

export function isPathInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export async function resolvePhysicalPath(candidate: string): Promise<string> {
  let cursor = resolve(candidate);
  const missing: string[] = [];

  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

export async function assertAuditRoot(candidate: string, realHome = homedir()): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new UnsafeAuditRootError("audit home must be an absolute path");
  }

  const [resolvedCandidate, resolvedHome] = await Promise.all([
    realpath(resolve(candidate)),
    realpath(resolve(realHome)),
  ]);

  if (resolvedCandidate === parse(resolvedCandidate).root) {
    throw new UnsafeAuditRootError("refusing to use the filesystem root");
  }

  if (resolvedCandidate !== resolvedHome && isPathInside(resolvedCandidate, resolvedHome)) {
    throw new UnsafeAuditRootError("refusing to use an ancestor of the real home directory");
  }

  return resolvedCandidate;
}

export async function assertDestructiveFixtureRoot(
  candidate: string,
  options: {
    temporaryRoot?: string;
    realHome?: string;
    repositoryRoot?: string;
  } = {},
): Promise<string> {
  const [resolvedCandidate, resolvedTemporaryRoot, resolvedHome, resolvedRepository] =
    await Promise.all([
      realpath(resolve(candidate)),
      realpath(resolve(options.temporaryRoot ?? tmpdir())),
      realpath(resolve(options.realHome ?? homedir())),
      realpath(resolve(options.repositoryRoot ?? process.cwd())),
    ]);

  if (resolvedCandidate === parse(resolvedCandidate).root) {
    throw new UnsafeDestructiveFixtureError("destructive fixture cannot use the filesystem root");
  }
  if (resolvedCandidate === resolvedTemporaryRoot) {
    throw new UnsafeDestructiveFixtureError("destructive fixture cannot use the temporary root");
  }
  if (!isPathInside(resolvedTemporaryRoot, resolvedCandidate)) {
    throw new UnsafeDestructiveFixtureError(
      "destructive fixture must be inside the selected temporary root",
    );
  }
  if (resolvedCandidate === resolvedHome) {
    throw new UnsafeDestructiveFixtureError("destructive fixture cannot use the real home");
  }
  if (
    isPathInside(resolvedCandidate, resolvedRepository) ||
    isPathInside(resolvedRepository, resolvedCandidate)
  ) {
    throw new UnsafeDestructiveFixtureError(
      "destructive fixture cannot overlap the repository checkout",
    );
  }

  return resolvedCandidate;
}
