import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import {
  countStatusSuppressedIndexEntries,
  parseGitStatusPorcelainV2,
} from "../adapters/git/status.js";
import type { QuarantineEntry, QuarantineStatus } from "../contracts/quarantine.js";
import { reconcileOwnedWorktreeLockClaim } from "./worktree-lock.js";
import {
  assertManifestPath,
  assertNoGitOperations,
  assertSupportedPlatform,
  assertTargetRegistrationLock,
  branchRef,
  type LockExpectation,
  lockMatches,
  pathExists,
  quarantineLockReason,
  readRecoveryRef,
  registrationMatches,
  resolveDependencies,
  type ResolvedRecoveryDependencies,
  WorktreeRecoveryError,
  type WorktreeRecoveryOptions,
} from "./worktree-recovery.js";

export async function validateQuarantinedEntry(
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

export async function verifyLockedRegistration(
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

export async function verifyRecoveryPath(
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
