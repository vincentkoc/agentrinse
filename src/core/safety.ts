import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export class UnsafeAuditRootError extends Error {
  override readonly name = "UnsafeAuditRootError";
}

export function assertSyntheticAuditRoot(
  candidate: string,
  realHome = homedir(),
): string {
  if (!isAbsolute(candidate)) {
    throw new UnsafeAuditRootError("audit home must be an absolute path");
  }

  const resolvedCandidate = resolve(candidate);
  const resolvedHome = resolve(realHome);

  if (resolvedCandidate === "/") {
    throw new UnsafeAuditRootError("refusing to use the filesystem root");
  }

  if (resolvedCandidate === resolvedHome) {
    throw new UnsafeAuditRootError(
      "pre-alpha builds refuse to audit the real home directory",
    );
  }

  const homeFromCandidate = relative(resolvedCandidate, resolvedHome);
  if (
    homeFromCandidate !== "" &&
    homeFromCandidate !== ".." &&
    !homeFromCandidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new UnsafeAuditRootError(
      "refusing to use an ancestor of the real home directory",
    );
  }

  return resolvedCandidate;
}

