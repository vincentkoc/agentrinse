import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { unlockOwnedWorktree } from "./worktree-lock.js";
import {
  assertNoGitOperations,
  assertTargetRegistrationLock,
  deleteRecoveryRef,
  ensureRecoveryRef,
  isImmutableRecoveryProtection,
  pathExists,
  persist,
  quarantineLockReason,
  registrationMatches,
  resolveDependencies,
  type ResolvedRecoveryDependencies,
  worktreePurgeIsolationPath,
  WorktreeRecoveryError,
  type WorktreeRecoveryOptions,
} from "./worktree-recovery.js";
import {
  validateQuarantinedEntry,
  verifyLockedRegistration,
  verifyRecoveryPath,
} from "./worktree-recovery-validation.js";

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
      "owned-or-unlocked",
      expectedRegistrationPaths,
    );
    await releaseOwnedRegistrationLock(entry, options, dependencies, entry.originalPath);
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

async function releaseOwnedRegistrationLock(
  entry: QuarantineEntry,
  options: WorktreeRecoveryOptions,
  dependencies: ResolvedRecoveryDependencies,
  worktreePath: string,
): Promise<void> {
  const registrations = await dependencies.runGit([
    "--git-dir",
    entry.target.repositoryCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (!registrationMatches(registrations, worktreePath, entry, "owned")) {
    return;
  }
  await unlockOwnedWorktree({
    worktreePath,
    repositoryCommonDir: entry.target.repositoryCommonDir,
    expectedReason: quarantineLockReason(entry),
    claimId: entry.entryId,
    runGit: dependencies.runGit,
    platform: options.dependencies?.platform ?? process.platform,
  });
  await assertTargetRegistrationLock(entry, dependencies, "unlocked", [worktreePath]);
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
      "owned-or-unlocked",
      [entry.originalPath, entry.quarantinePath, isolationPath],
    );
    await releaseOwnedRegistrationLock(entry, options, dependencies, entry.originalPath);
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
