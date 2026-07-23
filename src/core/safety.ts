import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export class UnsafeAuditRootError extends Error {
  override readonly name = "UnsafeAuditRootError";
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

export function assertAuditRoot(candidate: string, realHome = homedir()): string {
  if (!isAbsolute(candidate)) {
    throw new UnsafeAuditRootError("audit home must be an absolute path");
  }

  const resolvedCandidate = resolve(candidate);
  const resolvedHome = resolve(realHome);

  if (resolvedCandidate === "/") {
    throw new UnsafeAuditRootError("refusing to use the filesystem root");
  }

  if (resolvedCandidate !== resolvedHome && isPathInside(resolvedCandidate, resolvedHome)) {
    throw new UnsafeAuditRootError("refusing to use an ancestor of the real home directory");
  }

  return resolvedCandidate;
}
