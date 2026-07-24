import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import {
  countStatusSuppressedIndexEntries,
  parseGitStatusPorcelainV2,
} from "../adapters/git/status.js";
import {
  quarantineEntrySchema,
  type QuarantineEntry,
  type QuarantineStatus,
} from "../contracts/quarantine.js";
import { writeJsonAtomic } from "../state/json-file.js";
import { findGitOperations } from "./git-operation-state.js";
import { measurePath, type Measurement, type MeasureOptions } from "./measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "./mount-boundaries.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";
import { reconcileOwnedWorktreeLockClaim, unlockOwnedWorktree } from "./worktree-lock.js";

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

async function pathExists(
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

function branchRef(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function assertManifestPath(entry: QuarantineEntry, options: WorktreeRecoveryOptions): void {
  const expected = resolve(options.quarantineDirectory, `${entry.entryId}.json`);
  if (resolve(options.manifestPath) !== expected) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_MANIFEST_PATH_MISMATCH",
      "quarantine manifest filename does not match its entry ID",
      entry,
    );
  }
}

type LockExpectation = "owned" | "owned-or-unlocked" | "unlocked";

function quarantineLockReason(entry: QuarantineEntry): string {
  return `AgentRinse quarantine ${entry.entryId}`;
}

function lockMatches(
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

function registrationMatches(
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

type ResolvedRecoveryDependencies = Required<
  Pick<
    WorktreeRecoveryDependencies,
    "runGit" | "inspect" | "move" | "measure" | "processProbe" | "mountProbe" | "clock"
  >
>;

async function assertNoGitOperations(
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

async function assertTargetRegistrationLock(
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

function isImmutableRecoveryProtection(error: unknown): boolean {
  return (
    error instanceof WorktreeRecoveryError &&
    ["QUARANTINE_GIT_OPERATION_IN_PROGRESS", "QUARANTINE_REGISTRATION_CHANGED"].includes(error.code)
  );
}

function resolveDependencies(options: WorktreeRecoveryOptions): ResolvedRecoveryDependencies {
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

function assertSupportedPlatform(entry: QuarantineEntry, options: WorktreeRecoveryOptions): void {
  const platform = options.dependencies?.platform ?? process.platform;
  if (!["darwin", "linux"].includes(platform)) {
    throw new WorktreeRecoveryError(
      "WORKTREE_PLATFORM_UNSUPPORTED",
      `worktree recovery mutation is unsupported on ${platform}`,
      entry,
    );
  }
}

async function persist(
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

async function validateQuarantinedEntry(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
  requireOriginalVacant: boolean,
  acceptedStatuses: QuarantineStatus[] = ["quarantined"],
  lockExpectation: LockExpectation = "owned",
  worktreePath = entry.quarantinePath,
): Promise<{
  dependencies: ResolvedRecoveryDependencies;
  registrationLocked: boolean;
}> {
  const dependencies = resolveDependencies(options);
  const fail = (code: string, message: string): never => {
    throw new WorktreeRecoveryError(code, message, entry);
  };

  assertSupportedPlatform(entry, options);
  if (!acceptedStatuses.includes(entry.status)) {
    fail("QUARANTINE_NOT_LIVE", `quarantine entry status is ${entry.status}`);
  }
  assertManifestPath(entry, options);
  const quarantineIdentity =
    entry.quarantineIdentity ??
    fail("QUARANTINE_IDENTITY_MISSING", "post-repair quarantine identity is missing");
  if (requireOriginalVacant && (await pathExists(entry.originalPath, dependencies.inspect))) {
    fail("UNDO_DESTINATION_OCCUPIED", `original path is occupied: ${entry.originalPath}`);
  }

  const [quarantineStats, commonDirStats] = await Promise.all([
    dependencies.inspect(worktreePath),
    dependencies.inspect(entry.target.repositoryCommonDir),
  ]);
  if (
    !quarantineStats.isDirectory() ||
    quarantineStats.isSymbolicLink() ||
    quarantineStats.dev !== quarantineIdentity.device ||
    quarantineStats.ino !== quarantineIdentity.inode ||
    quarantineStats.mtimeMs !== quarantineIdentity.mtimeMs
  ) {
    fail("QUARANTINE_IDENTITY_CHANGED", "quarantined worktree filesystem identity changed");
  }
  if (!commonDirStats.isDirectory() || commonDirStats.isSymbolicLink()) {
    fail("QUARANTINE_REPOSITORY_CHANGED", "Git common directory is no longer a real directory");
  }
  await reconcileOwnedWorktreeLockClaim({
    worktreePath,
    repositoryCommonDir: entry.target.repositoryCommonDir,
    expectedReason: quarantineLockReason(entry),
    claimId: entry.entryId,
    runGit: dependencies.runGit,
    platform: options.dependencies?.platform ?? process.platform,
  });

  const measurement = await dependencies.measure(worktreePath, {
    maxEntries: entry.measurementMaxEntries,
    excludeRootEntries: [".git"],
  });
  if (
    measurement.truncated ||
    measurement.specialEntries > 0 ||
    measurement.mountBoundaries > 0 ||
    measurement.bytes !== quarantineIdentity.measuredBytes ||
    measurement.newestMtimeMs !== quarantineIdentity.newestMtimeMs ||
    measurement.fingerprint !== quarantineIdentity.fingerprint
  ) {
    fail("QUARANTINE_CONTENT_CHANGED", "quarantined worktree contents changed after apply");
  }
  const ownership = await dependencies.processProbe(worktreePath);
  if (ownership.status !== "idle") {
    fail(
      ownership.status === "busy" ? "QUARANTINE_PROCESS_ACTIVE" : "QUARANTINE_PROCESS_UNKNOWN",
      ownership.status === "busy"
        ? "a live process owns the quarantined worktree"
        : "live process ownership could not be proven idle",
    );
  }
  const mounts = await dependencies.mountProbe(worktreePath);
  if (mounts.status !== "clear") {
    fail(
      mounts.status === "blocked"
        ? "QUARANTINE_MOUNT_BOUNDARY"
        : "QUARANTINE_MOUNT_INSPECTION_UNKNOWN",
      mounts.status === "blocked"
        ? "quarantined worktree contains a mount boundary"
        : "mount boundaries could not be proven absent",
    );
  }

  const status = parseGitStatusPorcelainV2(
    await dependencies.runGit([
      "-C",
      worktreePath,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
  );
  const statusSuppressedEntries = countStatusSuppressedIndexEntries(
    await dependencies.runGit(["-C", worktreePath, "ls-files", "-z", "-v"]),
  );
  if (
    status.head !== entry.target.head ||
    branchRef(status.branch) !== entry.target.branch ||
    status.staged + status.modified + status.untracked + status.conflicted + status.ignored > 0 ||
    statusSuppressedEntries > 0
  ) {
    fail("QUARANTINE_GIT_STATE_CHANGED", "quarantined worktree is no longer clean at planned HEAD");
  }
  await assertNoGitOperations(entry, worktreePath, dependencies);
  const records = parseWorktreePorcelain(
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]),
  );
  const registration = records.find(
    (record) =>
      record.path === worktreePath &&
      record.head === entry.target.head &&
      record.branch === entry.target.branch,
  );
  if (registration === undefined) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_REGISTRATION_CHANGED",
      "quarantined worktree is no longer registered",
      entry,
    );
  }
  if (!lockMatches(registration.locked, lockExpectation, entry)) {
    fail("QUARANTINE_REGISTRATION_CHANGED", "quarantined worktree lock ownership changed");
  }
  const recoveryHead = await readRecoveryRef(entry, dependencies);
  if (recoveryHead === undefined || recoveryHead !== entry.target.head) {
    fail("QUARANTINE_RECOVERY_REF_CHANGED", "recovery ref no longer points to the planned HEAD");
  }

  return {
    dependencies,
    registrationLocked: registration.locked === quarantineLockReason(entry),
  };
}

async function deleteRecoveryRef(
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

async function ensureRecoveryRef(
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

async function readRecoveryRef(
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

async function verifyLockedRegistration(
  entry: QuarantineEntry,
  dependencies: ResolvedRecoveryDependencies,
): Promise<void> {
  const records = await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (!registrationMatches(records, entry.quarantinePath, entry, "owned")) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_REGISTRATION_CHANGED",
      "quarantined worktree could not be relocked during recovery",
      entry,
    );
  }
}

async function verifyRecoveryPath(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
  dependencies: ResolvedRecoveryDependencies,
  path: string,
  identity: QuarantineEntry["target"],
  allowMissingRecoveryRef: boolean,
  lockExpectation: LockExpectation,
  expectedRegistrationPaths: string[],
): Promise<void> {
  assertSupportedPlatform(entry, options);
  assertManifestPath(entry, options);
  const [stats, commonDirStats] = await Promise.all([
    dependencies.inspect(path),
    dependencies.inspect(entry.target.repositoryCommonDir),
  ]);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== identity.device ||
    stats.ino !== identity.inode ||
    stats.mtimeMs !== identity.mtimeMs ||
    !commonDirStats.isDirectory() ||
    commonDirStats.isSymbolicLink()
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_IDENTITY_CHANGED",
      "recovery worktree filesystem identity changed",
      entry,
    );
  }
  await reconcileOwnedWorktreeLockClaim({
    worktreePath: path,
    repositoryCommonDir: entry.target.repositoryCommonDir,
    expectedReason: quarantineLockReason(entry),
    claimId: entry.entryId,
    runGit: dependencies.runGit,
    platform: options.dependencies?.platform ?? process.platform,
  });
  const measurement = await dependencies.measure(path, {
    maxEntries: entry.measurementMaxEntries,
    excludeRootEntries: [".git"],
  });
  if (
    measurement.truncated ||
    measurement.specialEntries > 0 ||
    measurement.mountBoundaries > 0 ||
    measurement.bytes !== identity.measuredBytes ||
    measurement.newestMtimeMs !== identity.newestMtimeMs ||
    measurement.fingerprint !== identity.fingerprint
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_CONTENT_CHANGED",
      "recovery worktree contents changed",
      entry,
    );
  }
  const ownership = await dependencies.processProbe(path);
  if (ownership.status !== "idle") {
    throw new WorktreeRecoveryError(
      ownership.status === "busy" ? "QUARANTINE_PROCESS_ACTIVE" : "QUARANTINE_PROCESS_UNKNOWN",
      "recovery worktree process ownership is not idle",
      entry,
    );
  }
  const mounts = await dependencies.mountProbe(path);
  if (mounts.status !== "clear") {
    throw new WorktreeRecoveryError(
      mounts.status === "blocked"
        ? "QUARANTINE_MOUNT_BOUNDARY"
        : "QUARANTINE_MOUNT_INSPECTION_UNKNOWN",
      "recovery worktree mount state is not clear",
      entry,
    );
  }

  await assertNoGitOperations(entry, path, dependencies);
  await assertTargetRegistrationLock(
    entry,
    dependencies,
    lockExpectation,
    expectedRegistrationPaths,
  );
  await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "worktree",
    "repair",
    path,
  ]);
  const status = parseGitStatusPorcelainV2(
    await dependencies.runGit([
      "-C",
      path,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
  );
  const statusSuppressedEntries = countStatusSuppressedIndexEntries(
    await dependencies.runGit(["-C", path, "ls-files", "-z", "-v"]),
  );
  if (
    status.head !== entry.target.head ||
    branchRef(status.branch) !== entry.target.branch ||
    status.staged + status.modified + status.untracked + status.conflicted + status.ignored > 0 ||
    statusSuppressedEntries > 0
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_GIT_STATE_CHANGED",
      "recovery worktree Git state changed",
      entry,
    );
  }
  await assertNoGitOperations(entry, path, dependencies);
  const records = await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (!registrationMatches(records, path, entry, lockExpectation)) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_REGISTRATION_CHANGED",
      "recovery worktree registration could not be repaired",
      entry,
    );
  }
  const recoveryHead = await readRecoveryRef(entry, dependencies);
  if (
    recoveryHead !== entry.target.head &&
    !(allowMissingRecoveryRef && recoveryHead === undefined)
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_RECOVERY_REF_CHANGED",
      "recovery ref no longer points to the planned HEAD",
      entry,
    );
  }
}

async function recoverInitialQuarantineForUndo(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  const dependencies = resolveDependencies(options);
  const [originalExists, quarantineExists] = await Promise.all([
    pathExists(entry.originalPath, dependencies.inspect),
    pathExists(entry.quarantinePath, dependencies.inspect),
  ]);
  if (originalExists && !quarantineExists) {
    const expectedRegistrationPaths =
      entry.status === "moved" ? [entry.originalPath, entry.quarantinePath] : [entry.originalPath];
    await verifyRecoveryPath(
      entry,
      options,
      dependencies,
      entry.originalPath,
      entry.target,
      true,
      "unlocked",
      expectedRegistrationPaths,
    );
    await deleteRecoveryRef(entry, dependencies);
    return persist(
      {
        ...entry,
        status: "restored",
        restoredAt: dependencies.clock().toISOString(),
      },
      options,
    );
  }
  if (quarantineExists && !originalExists) {
    await verifyRecoveryPath(
      entry,
      options,
      dependencies,
      entry.quarantinePath,
      entry.target,
      true,
      "owned-or-unlocked",
      [entry.originalPath, entry.quarantinePath],
    );
    await ensureRecoveryRef(entry, dependencies);
    const records = await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!registrationMatches(records, entry.quarantinePath, entry, "owned")) {
      await dependencies.runGit([
        "--git-dir",
        entry.target.repositoryCommonDir,
        "worktree",
        "lock",
        "--reason",
        quarantineLockReason(entry),
        entry.quarantinePath,
      ]);
      await verifyLockedRegistration(entry, dependencies);
    }
    const [stats, measurement] = await Promise.all([
      dependencies.inspect(entry.quarantinePath),
      dependencies.measure(entry.quarantinePath, {
        maxEntries: entry.measurementMaxEntries,
        excludeRootEntries: [".git"],
      }),
    ]);
    return persist(
      {
        ...entry,
        status: "quarantined",
        quarantineIdentity: {
          ...entry.target,
          path: entry.quarantinePath,
          device: stats.dev,
          inode: stats.ino,
          mtimeMs: stats.mtimeMs,
          measuredBytes: measurement.bytes,
          newestMtimeMs: measurement.newestMtimeMs,
          fingerprint: measurement.fingerprint,
        },
      },
      options,
    );
  }
  throw new WorktreeRecoveryError(
    "QUARANTINE_INITIAL_TRANSITION_AMBIGUOUS",
    "interrupted quarantine has ambiguous source and destination paths",
    entry,
  );
}

async function resumeInterruptedUndo(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  const dependencies = resolveDependencies(options);
  const [originalExists, quarantineExists] = await Promise.all([
    pathExists(entry.originalPath, dependencies.inspect),
    pathExists(entry.quarantinePath, dependencies.inspect),
  ]);
  if (quarantineExists && !originalExists) {
    const validated = await validateQuarantinedEntry(
      entry,
      options,
      false,
      ["restoring"],
      "owned-or-unlocked",
    );
    if (!validated.registrationLocked) {
      await dependencies.runGit([
        "--git-dir",
        entry.target.repositoryCommonDir,
        "worktree",
        "lock",
        "--reason",
        quarantineLockReason(entry),
        entry.quarantinePath,
      ]);
      await verifyLockedRegistration(entry, dependencies);
    }
    return persist({ ...entry, status: "quarantined" }, options);
  }
  if (originalExists && !quarantineExists) {
    const identity =
      entry.quarantineIdentity ??
      (() => {
        throw new WorktreeRecoveryError(
          "QUARANTINE_IDENTITY_MISSING",
          "post-repair quarantine identity is missing",
          entry,
        );
      })();
    await verifyRecoveryPath(
      entry,
      options,
      dependencies,
      entry.originalPath,
      identity,
      true,
      "unlocked",
      [entry.quarantinePath, entry.originalPath],
    );
    await deleteRecoveryRef(entry, dependencies);
    const restored = await persist(
      {
        ...entry,
        status: "restored",
        restoredAt: dependencies.clock().toISOString(),
      },
      options,
    );
    return restored;
  }
  throw new WorktreeRecoveryError(
    "QUARANTINE_UNDO_TRANSITION_AMBIGUOUS",
    "interrupted undo has ambiguous source and destination paths",
    entry,
  );
}

export function worktreePurgeIsolationPath(entry: QuarantineEntry): string {
  return `${entry.quarantinePath}.purging`;
}

async function recoverPartialForUndo(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  const dependencies = resolveDependencies(options);
  const isolationPath = worktreePurgeIsolationPath(entry);
  const [originalExists, quarantineExists, isolationExists] = await Promise.all([
    pathExists(entry.originalPath, dependencies.inspect),
    pathExists(entry.quarantinePath, dependencies.inspect),
    pathExists(isolationPath, dependencies.inspect),
  ]);
  if ([originalExists, quarantineExists, isolationExists].filter(Boolean).length !== 1) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_PARTIAL_TRANSITION_AMBIGUOUS",
      "partial quarantine recovery requires exactly one known worktree path",
      entry,
    );
  }

  if (originalExists) {
    await verifyRecoveryPath(
      entry,
      options,
      dependencies,
      entry.originalPath,
      entry.quarantineIdentity ?? entry.target,
      true,
      "unlocked",
      [entry.originalPath, entry.quarantinePath, isolationPath],
    );
    await deleteRecoveryRef(entry, dependencies);
    return persist(
      {
        ...entry,
        status: "restored",
        restoredAt: dependencies.clock().toISOString(),
      },
      options,
    );
  }

  if (isolationExists) {
    const identity =
      entry.quarantineIdentity ??
      (() => {
        throw new WorktreeRecoveryError(
          "QUARANTINE_IDENTITY_MISSING",
          "partial purge recovery requires post-repair quarantine identity",
          entry,
        );
      })();
    await verifyRecoveryPath(
      entry,
      options,
      dependencies,
      isolationPath,
      identity,
      false,
      "unlocked",
      [entry.quarantinePath, isolationPath],
    );
    await dependencies.move(isolationPath, entry.quarantinePath);
  }

  const identity = entry.quarantineIdentity ?? entry.target;
  await verifyRecoveryPath(
    entry,
    options,
    dependencies,
    entry.quarantinePath,
    identity,
    true,
    "owned-or-unlocked",
    [entry.originalPath, entry.quarantinePath, isolationPath],
  );
  await ensureRecoveryRef(entry, dependencies);
  const records = await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (!registrationMatches(records, entry.quarantinePath, entry, "owned")) {
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      quarantineLockReason(entry),
      entry.quarantinePath,
    ]);
    await verifyLockedRegistration(entry, dependencies);
  }
  const [stats, measurement] = await Promise.all([
    dependencies.inspect(entry.quarantinePath),
    dependencies.measure(entry.quarantinePath, {
      maxEntries: entry.measurementMaxEntries,
      excludeRootEntries: [".git"],
    }),
  ]);
  return persist(
    {
      ...entry,
      status: "quarantined",
      quarantineIdentity: {
        ...identity,
        path: entry.quarantinePath,
        device: stats.dev,
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        measuredBytes: measurement.bytes,
        newestMtimeMs: measurement.newestMtimeMs,
        fingerprint: measurement.fingerprint,
      },
    },
    options,
  );
}

async function rollbackPurgeIsolation(
  entry: QuarantineEntry,
  isolationPath: string,
  options: PurgeWorktreeOptions,
  dependencies: ResolvedRecoveryDependencies,
  error: unknown,
): Promise<never> {
  try {
    if (
      (await pathExists(entry.quarantinePath, dependencies.inspect)) ||
      !(await pathExists(isolationPath, dependencies.inspect))
    ) {
      throw new Error("worktree paths are not safe for purge isolation rollback");
    }
    await assertNoGitOperations(entry, isolationPath, dependencies);
    await assertTargetRegistrationLock(entry, dependencies, "unlocked", [
      entry.quarantinePath,
      isolationPath,
    ]);
    await dependencies.move(isolationPath, entry.quarantinePath);
    await assertNoGitOperations(entry, entry.quarantinePath, dependencies);
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "repair",
      entry.quarantinePath,
    ]);
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      quarantineLockReason(entry),
      entry.quarantinePath,
    ]);
    await verifyLockedRegistration(entry, dependencies);
    const recovered = await persist(
      {
        ...entry,
        status: "quarantined",
        diagnostic: {
          severity: "error",
          code: "QUARANTINE_PURGE_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: "git",
          resourceId: entry.resourceId,
        },
      },
      options,
    );
    throw new WorktreeRecoveryError(
      "QUARANTINE_PURGE_FAILED",
      "purge failed and the isolated worktree was returned to locked quarantine",
      recovered,
      { cause: error },
    );
  } catch (recoveryError) {
    if (recoveryError instanceof WorktreeRecoveryError && recoveryError.cause === error) {
      throw recoveryError;
    }
    const partial = await persist(
      {
        ...entry,
        status: "partial",
        diagnostic: {
          severity: "error",
          code: "QUARANTINE_PURGE_PARTIAL",
          message: `purge left partial state: ${
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          }`,
          adapter: "git",
          resourceId: entry.resourceId,
        },
      },
      options,
    ).catch(() => entry);
    throw new WorktreeRecoveryError(
      "QUARANTINE_PURGE_PARTIAL",
      `purge left partial state; inspect ${options.manifestPath}`,
      partial,
      { cause: recoveryError },
    );
  }
}

async function resumeInterruptedPurge(
  entry: QuarantineEntry,
  options: PurgeWorktreeOptions,
): Promise<{ entry: QuarantineEntry; reclaimedBytes: number } | QuarantineEntry> {
  const dependencies = resolveDependencies(options);
  const isolationPath = worktreePurgeIsolationPath(entry);
  const [quarantineExists, isolationExists] = await Promise.all([
    pathExists(entry.quarantinePath, dependencies.inspect),
    pathExists(isolationPath, dependencies.inspect),
  ]);
  if (quarantineExists && isolationExists) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_PURGE_TRANSITION_AMBIGUOUS",
      "interrupted purge has both source and isolation paths",
      entry,
    );
  }
  if (quarantineExists) {
    const validated = await validateQuarantinedEntry(
      entry,
      options,
      false,
      ["purging"],
      "owned-or-unlocked",
    );
    if (!validated.registrationLocked) {
      await dependencies.runGit([
        "--git-dir",
        entry.target.repositoryCommonDir,
        "worktree",
        "lock",
        "--reason",
        quarantineLockReason(entry),
        entry.quarantinePath,
      ]);
      await verifyLockedRegistration(entry, dependencies);
    }
    return persist({ ...entry, status: "quarantined" }, options);
  }
  if (isolationExists) {
    try {
      await assertNoGitOperations(entry, isolationPath, dependencies);
      await assertTargetRegistrationLock(entry, dependencies, "unlocked", [
        entry.quarantinePath,
        isolationPath,
      ]);
      await dependencies.runGit([
        "--git-dir",
        entry.target.repositoryCommonDir,
        "worktree",
        "repair",
        isolationPath,
      ]);
      await validateQuarantinedEntry(entry, options, false, ["purging"], "unlocked", isolationPath);
      await options.revalidateProtection?.(entry);
      await dependencies.runGit([
        "--git-dir",
        entry.target.repositoryCommonDir,
        "worktree",
        "remove",
        isolationPath,
      ]);
      if (await pathExists(isolationPath, dependencies.inspect)) {
        throw new WorktreeRecoveryError(
          "QUARANTINE_PURGE_TRANSITION_AMBIGUOUS",
          "Git reported success but the purge isolation path remains",
          entry,
        );
      }
    } catch (error) {
      if (isImmutableRecoveryProtection(error)) {
        throw error;
      }
      return rollbackPurgeIsolation(entry, isolationPath, options, dependencies, error);
    }
  }
  if (!quarantineExists && !isolationExists) {
    assertSupportedPlatform(entry, options);
    assertManifestPath(entry, options);
    const records = await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (
      parseWorktreePorcelain(records).some(
        (record) =>
          record.path === entry.quarantinePath ||
          record.path === isolationPath ||
          (record.head === entry.target.head && record.branch === entry.target.branch),
      )
    ) {
      throw new WorktreeRecoveryError(
        "QUARANTINE_REGISTRATION_CHANGED",
        "interrupted purge left or moved the target worktree registration",
        entry,
      );
    }
    const recoveryHead = await readRecoveryRef(entry, dependencies);
    if (recoveryHead !== undefined && recoveryHead !== entry.target.head) {
      throw new WorktreeRecoveryError(
        "QUARANTINE_RECOVERY_REF_CHANGED",
        "recovery ref no longer points to the planned HEAD",
        entry,
      );
    }
    await deleteRecoveryRef(entry, dependencies);
    const purged = await persist(
      {
        ...entry,
        status: "purged",
        purgedAt: dependencies.clock().toISOString(),
      },
      options,
    );
    return { entry: purged, reclaimedBytes: purged.target.measuredBytes };
  }
  return resumeInterruptedPurge(entry, options);
}

export async function undoWorktreeQuarantine(
  input: QuarantineEntry,
  options: WorktreeRecoveryOptions,
): Promise<QuarantineEntry> {
  let entry = quarantineEntrySchema.parse(input);
  if (entry.status === "partial") {
    entry = await recoverPartialForUndo(entry, options);
    if (entry.status === "restored") {
      return entry;
    }
  }
  if (["preparing", "recovery-ref-created", "moved"].includes(entry.status)) {
    entry = await recoverInitialQuarantineForUndo(entry, options);
    if (entry.status === "restored") {
      return entry;
    }
  }
  if (entry.status === "restoring") {
    entry = await resumeInterruptedUndo(entry, options);
    if (entry.status === "restored") {
      return entry;
    }
  }
  const { dependencies } = await validateQuarantinedEntry(entry, options, true);
  entry = await persist({ ...entry, status: "restoring" }, options);
  let unlocked = false;
  let moved = false;
  let finalizing = false;

  try {
    await unlockOwnedWorktree({
      worktreePath: entry.quarantinePath,
      repositoryCommonDir: entry.target.repositoryCommonDir,
      expectedReason: quarantineLockReason(entry),
      claimId: entry.entryId,
      runGit: dependencies.runGit,
      platform: options.dependencies?.platform ?? process.platform,
    });
    unlocked = true;
    await assertTargetRegistrationLock(entry, dependencies, "unlocked", [entry.quarantinePath]);
    if (await pathExists(entry.originalPath, dependencies.inspect)) {
      throw new Error(`original path became occupied before undo: ${entry.originalPath}`);
    }
    await dependencies.move(entry.quarantinePath, entry.originalPath);
    moved = true;
    const identity =
      entry.quarantineIdentity ??
      (() => {
        throw new WorktreeRecoveryError(
          "QUARANTINE_IDENTITY_MISSING",
          "post-repair quarantine identity is missing",
          entry,
        );
      })();
    await verifyRecoveryPath(
      entry,
      options,
      dependencies,
      entry.originalPath,
      identity,
      false,
      "unlocked",
      [entry.quarantinePath, entry.originalPath],
    );
    await deleteRecoveryRef(entry, dependencies);
    finalizing = true;
    entry = await persist(
      {
        ...entry,
        status: "restored",
        restoredAt: dependencies.clock().toISOString(),
      },
      options,
    );
    return entry;
  } catch (error) {
    if (finalizing) {
      throw new WorktreeRecoveryError(
        "QUARANTINE_UNDO_FINALIZE_PENDING",
        "undo restored the worktree but could not persist terminal state; retry undo",
        entry,
        { cause: error },
      );
    }
    if (moved && isImmutableRecoveryProtection(error)) {
      throw error;
    }
    try {
      if (moved) {
        await assertNoGitOperations(entry, entry.originalPath, dependencies);
        await assertTargetRegistrationLock(entry, dependencies, "unlocked", [
          entry.quarantinePath,
          entry.originalPath,
        ]);
        if (
          (await pathExists(entry.quarantinePath, dependencies.inspect)) ||
          !(await pathExists(entry.originalPath, dependencies.inspect))
        ) {
          throw new Error("worktree paths are not safe for undo rollback");
        }
        await dependencies.move(entry.originalPath, entry.quarantinePath);
        await dependencies.runGit([
          "--git-dir",
          entry.target.repositoryCommonDir,
          "worktree",
          "repair",
          entry.quarantinePath,
        ]);
      }
      if (unlocked) {
        await dependencies.runGit([
          "--git-dir",
          entry.target.repositoryCommonDir,
          "worktree",
          "lock",
          "--reason",
          quarantineLockReason(entry),
          entry.quarantinePath,
        ]);
      }
      entry = await persist(
        {
          ...entry,
          status: "quarantined",
          diagnostic: {
            severity: "error",
            code: "QUARANTINE_UNDO_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: "git",
            resourceId: entry.resourceId,
          },
        },
        options,
      );
      throw new WorktreeRecoveryError(
        "QUARANTINE_UNDO_FAILED",
        "undo failed and the quarantine entry was restored",
        entry,
        { cause: error },
      );
    } catch (rollbackError) {
      if (rollbackError instanceof WorktreeRecoveryError && rollbackError.cause === error) {
        throw rollbackError;
      }
      entry = await persist(
        {
          ...entry,
          status: "partial",
          diagnostic: {
            severity: "error",
            code: "QUARANTINE_UNDO_PARTIAL",
            message: `undo failed and rollback was incomplete: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
            adapter: "git",
            resourceId: entry.resourceId,
          },
        },
        options,
      ).catch(() => entry);
      throw new WorktreeRecoveryError(
        "QUARANTINE_UNDO_PARTIAL",
        `undo left partial state; inspect ${options.manifestPath}`,
        entry,
        { cause: rollbackError },
      );
    }
  }
}

export async function purgeWorktreeQuarantine(
  input: QuarantineEntry,
  options: PurgeWorktreeOptions,
): Promise<{ entry: QuarantineEntry; reclaimedBytes: number }> {
  let entry = quarantineEntrySchema.parse(input);
  if (entry.status === "purging") {
    const resumed = await resumeInterruptedPurge(entry, options);
    if ("entry" in resumed) {
      return resumed;
    }
    entry = resumed;
  }
  const { dependencies } = await validateQuarantinedEntry(entry, options, false);
  if (
    options.allowUnexpired !== true &&
    dependencies.clock().getTime() < Date.parse(entry.expiresAt)
  ) {
    throw new WorktreeRecoveryError(
      "QUARANTINE_NOT_EXPIRED",
      `quarantine entry does not expire until ${entry.expiresAt}`,
      entry,
    );
  }
  entry = await persist({ ...entry, status: "purging" }, options);
  const isolationPath = worktreePurgeIsolationPath(entry);
  let unlocked = false;
  let isolated = false;
  let removed = false;

  try {
    await unlockOwnedWorktree({
      worktreePath: entry.quarantinePath,
      repositoryCommonDir: entry.target.repositoryCommonDir,
      expectedReason: quarantineLockReason(entry),
      claimId: entry.entryId,
      runGit: dependencies.runGit,
      platform: options.dependencies?.platform ?? process.platform,
    });
    unlocked = true;
    await validateQuarantinedEntry(entry, options, false, ["purging"], "unlocked");
    if (await pathExists(isolationPath, dependencies.inspect)) {
      throw new Error(`purge isolation path already exists: ${isolationPath}`);
    }
    await dependencies.move(entry.quarantinePath, isolationPath);
    isolated = true;
    await assertNoGitOperations(entry, isolationPath, dependencies);
    await assertTargetRegistrationLock(entry, dependencies, "unlocked", [
      entry.quarantinePath,
      isolationPath,
    ]);
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "repair",
      isolationPath,
    ]);
    await validateQuarantinedEntry(entry, options, false, ["purging"], "unlocked", isolationPath);
    await options.revalidateProtection?.(entry);
    await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "remove",
      isolationPath,
    ]);
    if (await pathExists(isolationPath, dependencies.inspect)) {
      throw new Error("Git reported success but the purge isolation path still exists");
    }
    removed = true;
    const records = await dependencies.runGit([
      "--git-dir",
      entry.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (
      parseWorktreePorcelain(records).some(
        (record) =>
          record.path === isolationPath ||
          (record.head === entry.target.head && record.branch === entry.target.branch),
      )
    ) {
      throw new Error("Git reported success but the target worktree registration remains or moved");
    }
    await deleteRecoveryRef(entry, dependencies);
    entry = await persist(
      {
        ...entry,
        status: "purged",
        purgedAt: dependencies.clock().toISOString(),
      },
      options,
    );
    return { entry, reclaimedBytes: entry.target.measuredBytes };
  } catch (error) {
    if (removed) {
      throw new WorktreeRecoveryError(
        "QUARANTINE_PURGE_FINALIZE_PENDING",
        "purge removed the worktree but could not persist terminal state; retry purge",
        entry,
        { cause: error },
      );
    }
    if (isolated && isImmutableRecoveryProtection(error)) {
      throw error;
    }
    try {
      if (isolated) {
        return rollbackPurgeIsolation(entry, isolationPath, options, dependencies, error);
      }
      if (await pathExists(entry.quarantinePath, dependencies.inspect)) {
        if (unlocked) {
          await dependencies.runGit([
            "--git-dir",
            entry.target.repositoryCommonDir,
            "worktree",
            "lock",
            "--reason",
            quarantineLockReason(entry),
            entry.quarantinePath,
          ]);
        }
        entry = await persist(
          {
            ...entry,
            status: "quarantined",
            diagnostic: {
              severity: "error",
              code: "QUARANTINE_PURGE_FAILED",
              message: error instanceof Error ? error.message : String(error),
              adapter: "git",
              resourceId: entry.resourceId,
            },
          },
          options,
        );
        throw new WorktreeRecoveryError(
          "QUARANTINE_PURGE_FAILED",
          unlocked
            ? "purge failed and the quarantine entry was relocked"
            : "purge failed before mutation and the quarantine entry remains retryable",
          entry,
          { cause: error },
        );
      }
      throw error;
    } catch (recoveryError) {
      if (recoveryError instanceof WorktreeRecoveryError && recoveryError.cause === error) {
        throw recoveryError;
      }
      entry = await persist(
        {
          ...entry,
          status: "partial",
          diagnostic: {
            severity: "error",
            code: "QUARANTINE_PURGE_PARTIAL",
            message: `purge left partial state: ${
              recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
            }`,
            adapter: "git",
            resourceId: entry.resourceId,
          },
        },
        options,
      ).catch(() => entry);
      throw new WorktreeRecoveryError(
        "QUARANTINE_PURGE_PARTIAL",
        `purge left partial state; inspect ${options.manifestPath}`,
        entry,
        { cause: recoveryError },
      );
    }
  }
}
