import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { writeJsonAtomic } from "../state/json-file.js";
import { findGitOperations } from "./git-operation-state.js";
import { measurePath, type Measurement, type MeasureOptions } from "./measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "./mount-boundaries.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";

const execFileAsync = promisify(execFile);

export class WorktreeRecoveryError extends Error {
  override readonly name = "WorktreeRecoveryError";

  constructor(
    readonly code: string,
    message: string,
    readonly entry: QuarantineEntry,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type WorktreeRecoveryDependencies = {
  runGit?: (args: string[]) => Promise<string>;
  inspect?: (path: string) => Promise<Stats>;
  move?: (source: string, destination: string) => Promise<void>;
  measure?: (path: string, options: MeasureOptions) => Promise<Measurement>;
  processProbe?: (path: string) => Promise<ProcessOwnershipResult>;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
  clock?: () => Date;
  platform?: NodeJS.Platform;
};

export type WorktreeRecoveryOptions = {
  manifestPath: string;
  quarantineDirectory: string;
  dependencies?: WorktreeRecoveryDependencies;
};

export type PurgeWorktreeOptions = WorktreeRecoveryOptions & {
  allowUnexpired?: boolean;
  revalidateProtection?: (entry: QuarantineEntry) => Promise<void>;
};

async function defaultGitRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isMissingGitRef(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return (error as { code?: string | number }).code === 1;
}

export async function pathExists(
  path: string,
  inspect: (path: string) => Promise<Stats>,
): Promise<boolean> {
  try {
    await inspect(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

export function branchRef(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

export function assertManifestPath(entry: QuarantineEntry, options: WorktreeRecoveryOptions): void {
  const expected = resolve(options.quarantineDirectory, `${entry.entryId}.json`);
  if (resolve(options.manifestPath) !== expected) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_MANIFEST_PATH_MISMATCH",
      "quarantine manifest filename does not match its entry ID",
      entry,
    );
  }
}

export type LockExpectation = "owned" | "owned-or-unlocked" | "unlocked";

export function quarantineLockReason(entry: QuarantineEntry): string {
  return `AgentRinse quarantine ${entry.entryId}`;
}

export function lockMatches(
  actual: string | undefined,
  expectation: LockExpectation,
  entry: QuarantineEntry,
): boolean {
  const owned = actual === quarantineLockReason(entry);
  if (expectation === "owned") {
    return owned;
  }
  if (expectation === "unlocked") {
    return actual === undefined;
  }
  return actual === undefined || owned;
}

export function registrationMatches(
  output: string,
  path: string,
  entry: QuarantineEntry,
  lockExpectation: LockExpectation,
): boolean {
  return parseWorktreePorcelain(output).some(
    (record) =>
      record.path === path &&
      record.head === entry.target.head &&
      record.branch === entry.target.branch &&
      lockMatches(record.locked, lockExpectation, entry),
  );
}

export type ResolvedRecoveryDependencies = Required<
  Pick<
    WorktreeRecoveryDependencies,
    "runGit" | "inspect" | "move" | "measure" | "processProbe" | "mountProbe" | "clock"
  >
>;

export async function assertNoGitOperations(
  entry: QuarantineEntry,
  worktreePath: string,
  dependencies: ResolvedRecoveryDependencies,
): Promise<void> {
  const operations = await findGitOperations(worktreePath, dependencies.runGit, (path) =>
    pathExists(path, dependencies.inspect),
  );
  if (operations.length > 0) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_GIT_OPERATION_IN_PROGRESS",
      `Git operation is in progress: ${operations.join(", ")}`,
      entry,
    );
  }
}

export async function assertTargetRegistrationLock(
  entry: QuarantineEntry,
  dependencies: ResolvedRecoveryDependencies,
  lockExpectation: LockExpectation,
  expectedPaths: string[],
): Promise<void> {
  const records = parseWorktreePorcelain(
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]),
  ).filter((record) => record.head === entry.target.head && record.branch === entry.target.branch);
  const registration = records[0];
  if (
    records.length !== 1 ||
    registration === undefined ||
    !expectedPaths.some((path) => resolve(path) === resolve(registration.path)) ||
    !lockMatches(registration.locked, lockExpectation, entry)
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_REGISTRATION_CHANGED",
      "target worktree registration or lock ownership changed before repair",
      entry,
    );
  }
}

export function isImmutableRecoveryProtection(error: unknown): boolean {
  return (
    error instanceof WorktreeRecoveryError &&
    ["QUARANTINE_GIT_OPERATION_IN_PROGRESS", "QUARANTINE_REGISTRATION_CHANGED"].includes(error.code)
  );
}

export function resolveDependencies(
  options: WorktreeRecoveryOptions,
): ResolvedRecoveryDependencies {
  return {
    runGit: options.dependencies?.runGit ?? defaultGitRunner,
    inspect: options.dependencies?.inspect ?? lstat,
    move:
      options.dependencies?.move ??
      ((source: string, destination: string) =>
        renameNoReplace(source, destination, options.dependencies?.platform ?? process.platform)),
    measure: options.dependencies?.measure ?? measurePath,
    processProbe: options.dependencies?.processProbe ?? findProcessesUsingPath,
    mountProbe: options.dependencies?.mountProbe ?? findMountBoundaries,
    clock: options.dependencies?.clock ?? (() => new Date()),
  };
}

export function assertSupportedPlatform(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): void {
  const platform = options.dependencies?.platform ?? process.platform;
  if (!["darwin", "linux"].includes(platform)) {
    throw new WorktreeRecoveryError(
      "WORKTREE_PLATFORM_UNSUPPORTED",
      `worktree recovery mutation is unsupported on ${platform}`,
      entry,
    );
  }
}

export async function persist(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  const parsed = quarantineEntrySchema.parse(entry);
  assertManifestPath(parsed, options);
  await writeJsonAtomic(options.manifestPath, parsed, {
    privateDirectories: [options.quarantineDirectory],
  });
  return parsed;
}

export async function deleteRecoveryRef(
  entry: QuarantineEntry,
  dependencies: ResolvedRecoveryDependencies,
): Promise<void> {
  const recoveryHead = await readRecoveryRef(entry, dependencies);
  if (recoveryHead === undefined) {
    return;
  }
  if (recoveryHead !== entry.target.head) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_RECOVERY_REF_CHANGED",
      "recovery ref no longer points to the planned HEAD",
      entry,
    );
  }
  await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "update-ref",
    "-d",
    entry.recoveryRef,
    entry.target.head,
  ]);
}

export async function ensureRecoveryRef(
  entry: QuarantineEntry,
  dependencies: ResolvedRecoveryDependencies,
): Promise<void> {
  const recoveryHead = await readRecoveryRef(entry, dependencies);
  if (recoveryHead === entry.target.head) {
    return;
  }
  if (recoveryHead !== undefined) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_RECOVERY_REF_CHANGED",
      "recovery ref no longer points to the planned HEAD",
      entry,
    );
  }
  await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "update-ref",
    entry.recoveryRef,
    entry.target.head,
    "",
  ]);
}

export async function readRecoveryRef(
  entry: QuarantineEntry,
  dependencies: ResolvedRecoveryDependencies,
): Promise<string | undefined> {
  try {
    return (
      await dependencies.runGit([
        "--git-dir",
        entry.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        "--quiet",
        entry.recoveryRef,
      ])
    ).trim();
  } catch (error) {
    if (isMissingGitRef(error)) {
      return undefined;
    }
    throw error;
  }
}

export function worktreePurgeIsolationPath(entry: QuarantineEntry): string {
  return `${entry.quarantinePath}.purging`;
}
