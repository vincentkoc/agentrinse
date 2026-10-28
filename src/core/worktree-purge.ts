import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { unlockOwnedWorktree } from "./worktree-lock.js";
import {
  assertManifestPath,
  assertNoGitOperations,
  assertSupportedPlatform,
  assertTargetRegistrationLock,
  deleteRecoveryRef,
  isImmutableRecoveryProtection,
  pathExists,
  persist,
  type PurgeWorktreeOptions,
  quarantineLockReason,
  readRecoveryRef,
  resolveDependencies,
  type ResolvedRecoveryDependencies,
  worktreePurgeIsolationPath,
  WorktreeRecoveryError,
} from "./worktree-recovery.js";
import {
  validateQuarantinedEntry,
  verifyLockedRegistration,
} from "./worktree-recovery-validation.js";

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
      await validateQuarantinedEntry(entry, options, false, ["purging"], "unlocked", isolationPath);
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
    await validateQuarantinedEntry(entry, options, false, ["purging"], "unlocked", isolationPath);
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
