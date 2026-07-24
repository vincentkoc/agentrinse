import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import {
  countStatusSuppressedIndexEntries,
  parseGitStatusPorcelainV2,
} from "../adapters/git/status.js";
import { listGitRefsForCommit } from "../adapters/git/refs.js";
import type { WorktreeQuarantineAction } from "../contracts/action.js";
import {
  quarantineEntryIdSchema,
  quarantineEntrySchema,
  quarantineRecoveryRef,
  type QuarantineEntry,
} from "../contracts/quarantine.js";
import { ensurePrivateDirectory, writeJsonAtomic } from "../state/json-file.js";
import { findGitOperations } from "./git-operation-state.js";
import { measurePath, type Measurement, type MeasureOptions } from "./measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "./mount-boundaries.js";
import { renameNoReplace } from "./no-clobber-rename.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";
import { unlockOwnedWorktree } from "./worktree-lock.js";

const execFileAsync = promisify(execFile);
const QUARANTINE_OWNER_DIRECTORY = ".agentrinse-owner";

type QuarantineContainerIdentity = {
  container: Stats;
  owner: Stats;
};

export type WorktreeExecutionOutcome =
  | "skipped-stale"
  | "failed"
  | "rolled-back"
  | "partially-applied";

export class WorktreeExecutionError extends Error {
  override readonly name = "WorktreeExecutionError";

  constructor(
    message: string,
    readonly outcome: WorktreeExecutionOutcome,
    readonly entry?: QuarantineEntry,
    options?: ErrorOptions & { diagnosticCode?: string; quarantinedBytes?: number },
  ) {
    super(message, options);
    this.diagnosticCode = options?.diagnosticCode;
    this.quarantinedBytes = options?.quarantinedBytes;
  }

  readonly diagnosticCode: string | undefined;
  readonly quarantinedBytes: number | undefined;
}

export type WorktreeExecutionResult = {
  quarantineEntryId: string;
  quarantinePath: string;
  recoveryRef: string;
  quarantinedBytes: number;
  manifestPath: string;
};

export type WorktreeExecutorDependencies = {
  runGit?: (args: string[]) => Promise<string>;
  inspect?: (path: string) => Promise<Stats>;
  move?: (source: string, destination: string) => Promise<void>;
  measure?: (path: string, options: MeasureOptions) => Promise<Measurement>;
  processProbe?: (path: string) => Promise<ProcessOwnershipResult>;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
  maxEntries?: number;
  clock?: () => Date;
  platform?: NodeJS.Platform;
  authorization?: {
    expiresAtMs: number;
    now: () => Date;
  };
  revalidateProtection?: () => Promise<void>;
};

export type ExecuteWorktreeQuarantineOptions = {
  runId: string;
  entryId: string;
  quarantineDirectory: string;
  dependencies?: WorktreeExecutorDependencies;
};

async function defaultGitRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  return result.stdout;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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

function matchesFilesystemIdentity(stats: Stats, action: WorktreeQuarantineAction): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.dev === action.target.device &&
    stats.ino === action.target.inode &&
    stats.mtimeMs === action.target.mtimeMs
  );
}

function branchRef(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function cleanStatusMatches(output: string, action: WorktreeQuarantineAction): boolean {
  const status = parseGitStatusPorcelainV2(output);
  return (
    status.head === action.target.head &&
    branchRef(status.branch) === action.target.branch &&
    status.staged + status.modified + status.untracked + status.conflicted + status.ignored === 0
  );
}

function assertAuthorized(
  authorization: WorktreeExecutorDependencies["authorization"],
  entry?: QuarantineEntry,
): void {
  if (authorization !== undefined && authorization.now().getTime() >= authorization.expiresAtMs) {
    throw new WorktreeExecutionError(
      "cleanup plan authorization expired before worktree quarantine",
      "skipped-stale",
      entry,
      { diagnosticCode: "PLAN_EXPIRED_DURING_APPLY" },
    );
  }
}

export function worktreeQuarantinePath(action: WorktreeQuarantineAction, entryId: string): string {
  return join(dirname(action.target.path), ".agentrinse-quarantine", entryId);
}

export function worktreeRecoveryRef(action: WorktreeQuarantineAction, runId: string): string {
  return quarantineRecoveryRef(runId, action.resourceId);
}

function worktreeLockReason(entryId: string): string {
  return `AgentRinse quarantine ${entryId}`;
}

function registeredWorktree(
  output: string,
  path: string,
  action: WorktreeQuarantineAction,
  expectedLockReason?: string,
): boolean {
  const expectedPath = resolve(path);
  return parseWorktreePorcelain(output).some(
    (record) =>
      resolve(record.path) === expectedPath &&
      record.head === action.target.head &&
      record.branch === action.target.branch &&
      record.locked === expectedLockReason,
  );
}

function targetRegistrationLockMatches(
  output: string,
  action: WorktreeQuarantineAction,
  expectedPath: string,
  expectedLockReason?: string,
): boolean {
  const records = parseWorktreePorcelain(output).filter(
    (record) => record.head === action.target.head && record.branch === action.target.branch,
  );
  return (
    records.length === 1 &&
    resolve(records[0]!.path) === resolve(expectedPath) &&
    records[0]?.locked === expectedLockReason
  );
}

function pathContains(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function assertQuarantineContainerAvailable(
  quarantineParent: string,
  repositoryCommonDir: string,
  runGit: (args: string[]) => Promise<string>,
  inspect: (path: string) => Promise<Stats>,
  entry?: QuarantineEntry,
): Promise<void> {
  const gitMarker = join(quarantineParent, ".git");
  if (await pathExists(gitMarker, inspect)) {
    throw new WorktreeExecutionError(
      "quarantine container is itself a Git worktree",
      "failed",
      entry,
      { diagnosticCode: "QUARANTINE_CONTAINER_WORKTREE" },
    );
  }
  const registrations = parseWorktreePorcelain(
    await runGit(["--git-dir", repositoryCommonDir, "worktree", "list", "--porcelain", "-z"]),
  );
  if (
    registrations.some(
      (registration) => resolve(registration.path) === resolve(quarantineParent),
    ) ||
    (await pathExists(gitMarker, inspect))
  ) {
    throw new WorktreeExecutionError(
      "quarantine container is itself a registered Git worktree",
      "failed",
      entry,
      { diagnosticCode: "QUARANTINE_CONTAINER_WORKTREE" },
    );
  }
}

async function reserveQuarantineContainer(
  quarantineParent: string,
  repositoryCommonDir: string,
  runGit: (args: string[]) => Promise<string>,
  inspect: (path: string) => Promise<Stats>,
  platform: NodeJS.Platform,
): Promise<QuarantineContainerIdentity> {
  await assertQuarantineContainerAvailable(quarantineParent, repositoryCommonDir, runGit, inspect);

  const ownerDirectory = join(quarantineParent, QUARANTINE_OWNER_DIRECTORY);
  const stagingDirectory = join(
    dirname(quarantineParent),
    `.${basename(quarantineParent)}.agentrinse-${randomUUID()}`,
  );
  let installedStagingDirectory = false;
  try {
    await mkdir(stagingDirectory, { mode: 0o700 });
    await mkdir(join(stagingDirectory, QUARANTINE_OWNER_DIRECTORY), { mode: 0o700 });
    try {
      await renameNoReplace(stagingDirectory, quarantineParent, platform);
      installedStagingDirectory = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EEXIST", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))
      ) {
        throw error;
      }
    }
  } finally {
    if (!installedStagingDirectory) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  await assertQuarantineContainerAvailable(quarantineParent, repositoryCommonDir, runGit, inspect);
  const [containerStats, ownerStats] = await Promise.all([
    inspect(quarantineParent),
    inspect(ownerDirectory),
  ]).catch((error: unknown) => {
    throw new WorktreeExecutionError(
      "existing quarantine container is not owned by AgentRinse",
      "failed",
      undefined,
      { cause: error, diagnosticCode: "QUARANTINE_CONTAINER_UNSAFE" },
    );
  });
  if (
    !containerStats.isDirectory() ||
    containerStats.isSymbolicLink() ||
    !ownerStats.isDirectory() ||
    ownerStats.isSymbolicLink()
  ) {
    throw new WorktreeExecutionError(
      "quarantine container ownership marker is not a real directory",
      "failed",
      undefined,
      { diagnosticCode: "QUARANTINE_CONTAINER_UNSAFE" },
    );
  }
  await ensurePrivateDirectory(quarantineParent);
  await ensurePrivateDirectory(ownerDirectory);
  const [container, owner] = await Promise.all([
    inspect(quarantineParent),
    inspect(ownerDirectory),
  ]);
  return { container, owner };
}

async function assertNoGitOperations(
  worktreePath: string,
  entry: QuarantineEntry,
  runGit: (args: string[]) => Promise<string>,
  inspect: (path: string) => Promise<Stats>,
): Promise<void> {
  const operations = await findGitOperations(worktreePath, runGit, (path) =>
    pathExists(path, inspect),
  );
  if (operations.length > 0) {
    throw new WorktreeExecutionError(
      `Git operation started before quarantine: ${operations.join(", ")}`,
      "skipped-stale",
      entry,
      { diagnosticCode: "GIT_OPERATION_IN_PROGRESS" },
    );
  }
}

async function assertCleanPushedGitState(
  action: WorktreeQuarantineAction,
  worktreePath: string,
  entry: QuarantineEntry,
  runGit: (args: string[]) => Promise<string>,
  inspect: (path: string) => Promise<Stats>,
): Promise<void> {
  const statusOutput = await runGit([
    "-C",
    worktreePath,
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  const status = parseGitStatusPorcelainV2(statusOutput);
  const indexFlags = await runGit(["-C", worktreePath, "ls-files", "-z", "-v"]);
  if (
    !cleanStatusMatches(statusOutput, action) ||
    countStatusSuppressedIndexEntries(indexFlags) > 0
  ) {
    throw new WorktreeExecutionError(
      "worktree Git state changed before quarantine",
      "skipped-stale",
      entry,
      { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
    );
  }
  const { containingRefs } = await listGitRefsForCommit(
    (args) => runGit(["--git-dir", action.target.repositoryCommonDir, ...args]),
    action.target.head,
  );
  if (
    status.ahead > 0 ||
    action.target.branch === undefined ||
    !containingRefs.includes(action.target.branch) ||
    !containingRefs.some((ref) => ref.startsWith("refs/remotes/"))
  ) {
    throw new WorktreeExecutionError(
      "worktree HEAD is no longer proven pushed before quarantine",
      "skipped-stale",
      entry,
      { diagnosticCode: "WORKTREE_UNPUSHED" },
    );
  }
  await assertNoGitOperations(worktreePath, entry, runGit, inspect);
}

async function writeManifest(
  manifestPath: string,
  quarantineDirectory: string,
  entry: QuarantineEntry,
): Promise<QuarantineEntry> {
  const parsed = quarantineEntrySchema.parse(entry);
  await writeJsonAtomic(manifestPath, parsed, {
    privateDirectories: [quarantineDirectory],
  });
  return parsed;
}

export async function executeWorktreeQuarantine(
  action: WorktreeQuarantineAction,
  options: ExecuteWorktreeQuarantineOptions,
): Promise<WorktreeExecutionResult> {
  const dependencies = options.dependencies ?? {};
  const runGit = dependencies.runGit ?? defaultGitRunner;
  const inspect = dependencies.inspect ?? lstat;
  const platform = dependencies.platform ?? process.platform;
  const move =
    dependencies.move ?? ((source, destination) => renameNoReplace(source, destination, platform));
  const measure = dependencies.measure ?? measurePath;
  const processProbe = dependencies.processProbe ?? findProcessesUsingPath;
  const mountProbe = dependencies.mountProbe ?? findMountBoundaries;
  const clock = dependencies.clock ?? (() => new Date());
  if (!["darwin", "linux"].includes(platform)) {
    throw new WorktreeExecutionError(
      `worktree quarantine mutation is unsupported on ${platform}`,
      "failed",
      undefined,
      { diagnosticCode: "WORKTREE_PLATFORM_UNSUPPORTED" },
    );
  }
  const entryId = quarantineEntryIdSchema.parse(options.entryId);
  const quarantinePath = worktreeQuarantinePath(action, entryId);
  if (pathContains(action.target.path, quarantinePath)) {
    throw new WorktreeExecutionError(
      "worktree occupies AgentRinse's reserved quarantine container",
      "failed",
      undefined,
      { diagnosticCode: "QUARANTINE_PATH_CONFLICT" },
    );
  }
  const quarantineParent = dirname(quarantinePath);
  const recoveryRef = worktreeRecoveryRef(action, options.runId);
  const manifestPath = join(options.quarantineDirectory, `${entryId}.json`);
  const createdAt = clock();
  const measurementMaxEntries = dependencies.maxEntries ?? 100_000;
  let entry = quarantineEntrySchema.parse({
    schemaVersion: 1,
    entryId,
    runId: options.runId,
    actionId: action.actionId,
    resourceId: action.resourceId,
    status: "preparing",
    originalPath: action.target.path,
    quarantinePath,
    recoveryRef,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + action.quarantineTtlMinutes * 60_000).toISOString(),
    measurementMaxEntries,
    target: action.target,
  });
  let refCreated = false;
  let moved = false;
  let repaired = false;
  let locked = false;

  const quarantineParentIdentity = await reserveQuarantineContainer(
    quarantineParent,
    action.target.repositoryCommonDir,
    runGit,
    inspect,
    platform,
  );
  await ensurePrivateDirectory(options.quarantineDirectory);
  entry = await writeManifest(manifestPath, options.quarantineDirectory, entry);

  try {
    const [targetStats, quarantineParentStats, commonDirStats] = await Promise.all([
      inspect(action.target.path),
      inspect(quarantineParent),
      inspect(action.target.repositoryCommonDir),
    ]);
    if (!matchesFilesystemIdentity(targetStats, action)) {
      throw new WorktreeExecutionError(
        "worktree filesystem identity changed before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (
      !quarantineParentStats.isDirectory() ||
      quarantineParentStats.isSymbolicLink() ||
      quarantineParentStats.dev !== targetStats.dev ||
      quarantineParentStats.dev !== quarantineParentIdentity.container.dev ||
      quarantineParentStats.ino !== quarantineParentIdentity.container.ino
    ) {
      throw new WorktreeExecutionError(
        "quarantine directory is not a real directory on the worktree filesystem",
        "failed",
        entry,
        { diagnosticCode: "QUARANTINE_CROSS_DEVICE" },
      );
    }
    if (!commonDirStats.isDirectory() || commonDirStats.isSymbolicLink()) {
      throw new WorktreeExecutionError(
        "Git common directory is no longer a real directory",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (await pathExists(quarantinePath, inspect)) {
      throw new WorktreeExecutionError(
        `refusing to overwrite existing quarantine path ${quarantinePath}`,
        "failed",
        entry,
      );
    }
    const before = await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!registeredWorktree(before, action.target.path, action)) {
      throw new WorktreeExecutionError(
        "Git worktree registration changed before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }

    assertAuthorized(dependencies.authorization, entry);
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "update-ref",
      recoveryRef,
      action.target.head,
      "",
    ]);
    refCreated = true;
    entry = await writeManifest(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "recovery-ref-created",
    });

    const boundaryStats = await inspect(action.target.path);
    if (!matchesFilesystemIdentity(boundaryStats, action)) {
      throw new WorktreeExecutionError(
        "worktree filesystem identity changed at the quarantine boundary",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    const boundaryMeasurement = await measure(action.target.path, {
      maxEntries: measurementMaxEntries,
      excludeRootEntries: [".git"],
    });
    if (
      boundaryMeasurement.truncated ||
      boundaryMeasurement.specialEntries > 0 ||
      boundaryMeasurement.mountBoundaries > 0 ||
      boundaryMeasurement.bytes !== action.target.measuredBytes ||
      boundaryMeasurement.newestMtimeMs !== action.target.newestMtimeMs ||
      boundaryMeasurement.fingerprint !== action.target.fingerprint
    ) {
      throw new WorktreeExecutionError(
        "worktree contents changed at the quarantine boundary",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    const boundaryMounts = await mountProbe(action.target.path);
    if (boundaryMounts.status !== "clear") {
      throw new WorktreeExecutionError(
        boundaryMounts.status === "blocked"
          ? "worktree gained a mount boundary before quarantine"
          : "mount boundaries could not be proven absent before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    await assertCleanPushedGitState(action, action.target.path, entry, runGit, inspect);
    const boundaryOwnership = await processProbe(action.target.path);
    if (boundaryOwnership.status !== "idle") {
      throw new WorktreeExecutionError(
        boundaryOwnership.status === "busy"
          ? "a live process acquired the worktree before quarantine"
          : "live process ownership could not be proven idle before quarantine",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (await pathExists(quarantinePath, inspect)) {
      throw new WorktreeExecutionError(
        `refusing to overwrite existing quarantine path ${quarantinePath}`,
        "failed",
        entry,
      );
    }

    assertAuthorized(dependencies.authorization, entry);
    await assertQuarantineContainerAvailable(
      quarantineParent,
      action.target.repositoryCommonDir,
      runGit,
      inspect,
      entry,
    );
    const [finalQuarantineParentStats, finalQuarantineOwnerStats] = await Promise.all([
      inspect(quarantineParent),
      inspect(join(quarantineParent, QUARANTINE_OWNER_DIRECTORY)),
    ]);
    if (
      !finalQuarantineParentStats.isDirectory() ||
      finalQuarantineParentStats.isSymbolicLink() ||
      finalQuarantineParentStats.dev !== quarantineParentIdentity.container.dev ||
      finalQuarantineParentStats.ino !== quarantineParentIdentity.container.ino ||
      !finalQuarantineOwnerStats.isDirectory() ||
      finalQuarantineOwnerStats.isSymbolicLink() ||
      finalQuarantineOwnerStats.dev !== quarantineParentIdentity.owner.dev ||
      finalQuarantineOwnerStats.ino !== quarantineParentIdentity.owner.ino
    ) {
      throw new WorktreeExecutionError(
        "quarantine container identity changed before the atomic move",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    try {
      await dependencies.revalidateProtection?.();
    } catch (error) {
      throw new WorktreeExecutionError(
        "worktree became protected before quarantine",
        "skipped-stale",
        entry,
        {
          cause: error,
          diagnosticCode: "WORKTREE_PROTECTION_CHANGED",
        },
      );
    }
    assertAuthorized(dependencies.authorization, entry);
    const finalBoundaryStats = await inspect(action.target.path);
    if (!matchesFilesystemIdentity(finalBoundaryStats, action)) {
      throw new WorktreeExecutionError(
        "worktree filesystem identity changed after the protection refresh",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    const finalBoundaryMounts = await mountProbe(action.target.path);
    if (finalBoundaryMounts.status !== "clear") {
      throw new WorktreeExecutionError(
        finalBoundaryMounts.status === "blocked"
          ? "worktree gained a mount boundary during the protection refresh"
          : "mount boundaries could not be proven absent after the protection refresh",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    await assertCleanPushedGitState(action, action.target.path, entry, runGit, inspect);
    const finalBoundaryOwnership = await processProbe(action.target.path);
    if (finalBoundaryOwnership.status !== "idle") {
      throw new WorktreeExecutionError(
        finalBoundaryOwnership.status === "busy"
          ? "a live process acquired the worktree during the protection refresh"
          : "live process ownership could not be proven idle after the protection refresh",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    if (await pathExists(quarantinePath, inspect)) {
      throw new WorktreeExecutionError(
        `refusing to overwrite existing quarantine path ${quarantinePath}`,
        "failed",
        entry,
      );
    }
    await assertQuarantineContainerAvailable(
      quarantineParent,
      action.target.repositoryCommonDir,
      runGit,
      inspect,
      entry,
    );
    const [moveQuarantineParentStats, moveQuarantineOwnerStats] = await Promise.all([
      inspect(quarantineParent),
      inspect(join(quarantineParent, QUARANTINE_OWNER_DIRECTORY)),
    ]);
    if (
      !moveQuarantineParentStats.isDirectory() ||
      moveQuarantineParentStats.isSymbolicLink() ||
      moveQuarantineParentStats.dev !== quarantineParentIdentity.container.dev ||
      moveQuarantineParentStats.ino !== quarantineParentIdentity.container.ino ||
      !moveQuarantineOwnerStats.isDirectory() ||
      moveQuarantineOwnerStats.isSymbolicLink() ||
      moveQuarantineOwnerStats.dev !== quarantineParentIdentity.owner.dev ||
      moveQuarantineOwnerStats.ino !== quarantineParentIdentity.owner.ino
    ) {
      throw new WorktreeExecutionError(
        "quarantine container identity changed during the protection refresh",
        "skipped-stale",
        entry,
        { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" },
      );
    }
    try {
      await move(action.target.path, quarantinePath);
    } catch (error) {
      throw new WorktreeExecutionError(
        "worktree could not be atomically moved into quarantine",
        isMissing(error) ? "skipped-stale" : "failed",
        entry,
        {
          cause: error,
          ...(error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "EXDEV"
            ? { diagnosticCode: "QUARANTINE_CROSS_DEVICE" }
            : isMissing(error)
              ? { diagnosticCode: "WORKTREE_IDENTITY_CHANGED" }
              : {}),
        },
      );
    }
    moved = true;
    entry = await writeManifest(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "moved",
    });

    const [quarantinedStats, isolatedMeasurement] = await Promise.all([
      inspect(quarantinePath),
      measure(quarantinePath, {
        maxEntries: measurementMaxEntries,
        excludeRootEntries: [".git"],
      }),
    ]);
    if (
      !matchesFilesystemIdentity(quarantinedStats, action) ||
      isolatedMeasurement.truncated ||
      isolatedMeasurement.specialEntries > 0 ||
      isolatedMeasurement.mountBoundaries > 0 ||
      isolatedMeasurement.bytes !== action.target.measuredBytes ||
      isolatedMeasurement.newestMtimeMs !== action.target.newestMtimeMs ||
      isolatedMeasurement.fingerprint !== action.target.fingerprint
    ) {
      throw new WorktreeExecutionError(
        "worktree contents or identity changed during quarantine",
        "partially-applied",
        entry,
      );
    }
    await assertNoGitOperations(quarantinePath, entry, runGit, inspect);
    const beforeRepair = await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!targetRegistrationLockMatches(beforeRepair, action, action.target.path)) {
      throw new WorktreeExecutionError(
        "worktree registration or lock ownership changed before repair",
        "partially-applied",
        entry,
        { diagnosticCode: "QUARANTINE_REGISTRATION_CHANGED" },
      );
    }
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "repair",
      quarantinePath,
    ]);
    repaired = true;
    await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "lock",
      "--reason",
      worktreeLockReason(entryId),
      quarantinePath,
    ]);
    locked = true;
    const after = await runGit([
      "--git-dir",
      action.target.repositoryCommonDir,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    if (!registeredWorktree(after, quarantinePath, action, worktreeLockReason(entryId))) {
      throw new WorktreeExecutionError(
        "quarantined worktree registration could not be verified",
        "partially-applied",
        entry,
      );
    }
    const verifiedRef = (
      await runGit([
        "--git-dir",
        action.target.repositoryCommonDir,
        "rev-parse",
        "--verify",
        recoveryRef,
      ])
    ).trim();
    if (verifiedRef !== action.target.head) {
      throw new WorktreeExecutionError(
        "quarantine recovery ref does not match the planned HEAD",
        "partially-applied",
        entry,
      );
    }
    const [quarantineStats, quarantineMeasurement] = await Promise.all([
      inspect(quarantinePath),
      measure(quarantinePath, {
        maxEntries: measurementMaxEntries,
        excludeRootEntries: [".git"],
      }),
    ]);
    if (
      !quarantineStats.isDirectory() ||
      quarantineStats.isSymbolicLink() ||
      quarantineStats.dev !== action.target.device ||
      quarantineStats.ino !== action.target.inode ||
      quarantineMeasurement.truncated ||
      quarantineMeasurement.specialEntries > 0 ||
      quarantineMeasurement.mountBoundaries > 0 ||
      quarantineMeasurement.bytes !== action.target.measuredBytes ||
      quarantineMeasurement.newestMtimeMs !== action.target.newestMtimeMs ||
      quarantineMeasurement.fingerprint !== action.target.fingerprint
    ) {
      throw new WorktreeExecutionError(
        "post-repair quarantine identity could not be proven",
        "partially-applied",
        entry,
      );
    }
    const finalStatus = await runGit([
      "-C",
      quarantinePath,
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    const finalIndexFlags = await runGit(["-C", quarantinePath, "ls-files", "-z", "-v"]);
    if (
      !cleanStatusMatches(finalStatus, action) ||
      countStatusSuppressedIndexEntries(finalIndexFlags) > 0
    ) {
      throw new WorktreeExecutionError(
        "quarantined worktree Git state changed before commit",
        "partially-applied",
        entry,
      );
    }
    await assertNoGitOperations(quarantinePath, entry, runGit, inspect);
    const finalMounts = await mountProbe(quarantinePath);
    if (finalMounts.status !== "clear") {
      throw new WorktreeExecutionError(
        finalMounts.status === "blocked"
          ? "quarantined worktree gained a mount boundary before commit"
          : "mount boundaries could not be proven absent before quarantine commit",
        "partially-applied",
        entry,
      );
    }
    const finalOwnership = await processProbe(quarantinePath);
    if (finalOwnership.status !== "idle") {
      throw new WorktreeExecutionError(
        finalOwnership.status === "busy"
          ? "a live process acquired the quarantined worktree before commit"
          : "live process ownership could not be proven idle before quarantine commit",
        "partially-applied",
        entry,
      );
    }

    entry = await writeManifest(manifestPath, options.quarantineDirectory, {
      ...entry,
      status: "quarantined",
      quarantineIdentity: {
        ...action.target,
        path: quarantinePath,
        device: quarantineStats.dev,
        inode: quarantineStats.ino,
        mtimeMs: quarantineStats.mtimeMs,
        measuredBytes: quarantineMeasurement.bytes,
        newestMtimeMs: quarantineMeasurement.newestMtimeMs,
        fingerprint: quarantineMeasurement.fingerprint,
      },
    });
    return {
      quarantineEntryId: entry.entryId,
      quarantinePath: entry.quarantinePath,
      recoveryRef: entry.recoveryRef,
      quarantinedBytes: action.target.measuredBytes,
      manifestPath,
    };
  } catch (error) {
    const executionError =
      error instanceof WorktreeExecutionError
        ? error
        : new WorktreeExecutionError(
            error instanceof Error ? error.message : String(error),
            moved ? "partially-applied" : "failed",
            entry,
            { cause: error },
          );
    const diagnostic = {
      severity: "error" as const,
      code: executionError.diagnosticCode ?? "WORKTREE_QUARANTINE_FAILED",
      message: executionError.message,
      adapter: action.adapter,
      resourceId: action.resourceId,
    };

    let rollbackFinalizing = false;
    try {
      if (locked) {
        await unlockOwnedWorktree({
          worktreePath: quarantinePath,
          repositoryCommonDir: action.target.repositoryCommonDir,
          expectedReason: worktreeLockReason(entryId),
          claimId: entryId,
          runGit,
          platform,
        });
        locked = false;
      }
      if (moved) {
        await assertNoGitOperations(quarantinePath, entry, runGit, inspect);
        const beforeRollbackRepair = await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (
          !targetRegistrationLockMatches(
            beforeRollbackRepair,
            action,
            repaired ? quarantinePath : action.target.path,
          )
        ) {
          throw new Error("worktree lock ownership changed before automatic rollback");
        }
        if (
          (await pathExists(action.target.path, inspect)) ||
          !(await pathExists(quarantinePath, inspect))
        ) {
          throw new Error("worktree paths are not safe for automatic rollback");
        }
        await move(quarantinePath, action.target.path);
        moved = false;
        await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "repair",
          action.target.path,
        ]);
        const restored = await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (!registeredWorktree(restored, action.target.path, action)) {
          throw new Error("restored Git worktree registration could not be verified");
        }
      }
      rollbackFinalizing = true;
      if (refCreated) {
        await runGit([
          "--git-dir",
          action.target.repositoryCommonDir,
          "update-ref",
          "-d",
          recoveryRef,
          action.target.head,
        ]);
        refCreated = false;
      }
      entry = await writeManifest(manifestPath, options.quarantineDirectory, {
        ...entry,
        status: "restored",
        restoredAt: clock().toISOString(),
        diagnostic,
      });
      throw new WorktreeExecutionError(
        moved ? `${executionError.message}; worktree rollback completed` : executionError.message,
        executionError.outcome === "skipped-stale"
          ? "skipped-stale"
          : executionError.entry?.status === "moved" ||
              executionError.outcome === "partially-applied"
            ? "rolled-back"
            : "failed",
        entry,
        {
          cause: executionError,
          ...(executionError.diagnosticCode === undefined
            ? {}
            : { diagnosticCode: executionError.diagnosticCode }),
        },
      );
    } catch (rollbackError) {
      if (
        rollbackError instanceof WorktreeExecutionError &&
        rollbackError.cause === executionError
      ) {
        throw rollbackError;
      }
      if (rollbackFinalizing) {
        throw new WorktreeExecutionError(
          "worktree rollback restored the original path but finalization is pending; retry undo",
          "partially-applied",
          entry,
          {
            cause: rollbackError,
            diagnosticCode: "WORKTREE_ROLLBACK_FINALIZE_PENDING",
          },
        );
      }
      entry = await writeManifest(manifestPath, options.quarantineDirectory, {
        ...entry,
        status: "partial",
        diagnostic: {
          ...diagnostic,
          code: "WORKTREE_QUARANTINE_PARTIAL",
          message: `${executionError.message}; automatic rollback failed: ${
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          }`,
        },
      }).catch(() => entry);
      throw new WorktreeExecutionError(
        `worktree quarantine failed with partial state; inspect ${manifestPath}`,
        "partially-applied",
        entry,
        {
          cause: rollbackError,
          diagnosticCode: "WORKTREE_QUARANTINE_PARTIAL",
          quarantinedBytes: moved ? action.target.measuredBytes : 0,
        },
      );
    }
  }
}
