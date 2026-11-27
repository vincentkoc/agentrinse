import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_WORKTREE_RETENTION } from "../../config/defaults.js";
import type { AgentRinseConfig } from "../../config/schema.js";
import type {
  AuditAdapter,
  AuditContext,
  CollectionObserver,
  CollectionResult,
} from "../../contracts/adapter.js";
import type { WorktreeQuarantineAction } from "../../contracts/action.js";
import type { Diagnostic } from "../../contracts/diagnostic.js";
import type { Finding } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import { findGitOperations } from "../../core/git-operation-state.js";
import { measurePath, type Measurement } from "../../core/measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "../../core/mount-boundaries.js";
import {
  findProcessesUsingPath,
  type ProcessOwnershipResult,
} from "../../core/process-ownership.js";
import type { ReachabilityIndex } from "../../core/reachability.js";
import { worktreeProtectionRoots } from "../../rules/git/worktree.js";
import { shouldDeferProcessOwnership } from "../../rules/git/registration.js";
import { parseWorktreePorcelain, type GitWorktreeRecord } from "./porcelain.js";
import { isPushedHead, matchingGitRefPins } from "./refs.js";
import {
  countStatusSuppressedIndexEntries,
  parseGitStatusPorcelainV2,
  type GitStatusFacts,
} from "./status.js";

const execFileAsync = promisify(execFile);
export type GitRunner = (args: string[], signal?: AbortSignal) => Promise<string>;
export type GitPathExists = (path: string) => Promise<boolean>;
export type GitProcessProbe = (path: string) => Promise<ProcessOwnershipResult>;
export type GitWorktreeOptions = Pick<AgentRinseConfig["audit"], "maxEntries" | "measureBytes"> &
  Partial<Pick<AgentRinseConfig["audit"], "gitTimeoutMs">> &
  AgentRinseConfig["worktrees"] & {
    platform: NodeJS.Platform;
  };
export type GitWorktreeDependencies = {
  // Report-only grading selects a member after the full native roster establishes the main.
  selectedPath?: string;
  measure?: typeof measurePath;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
  inspect?: typeof lstat;
  isolateRepositoryFailure?: boolean;
  discovery?: {
    records?: readonly GitWorktreeRecord[];
    diagnostic?: Diagnostic;
  };
};

const DEFAULT_OPTIONS: GitWorktreeOptions = {
  maxEntries: 100_000,
  measureBytes: true,
  gitTimeoutMs: 10_000,
  ...DEFAULT_WORKTREE_RETENTION,
  platform: process.platform,
};

// `git ls-files -z --stage` and `-z -v` scale with the index: about 100 bytes per tracked file.
// 4 MiB failed whole-repository inspection at roughly 40k files.
export const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

async function defaultGitRunner(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    signal,
  });
  return result.stdout;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function lines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function branchRef(branch: string | undefined): string | undefined {
  if (branch === undefined) {
    return undefined;
  }
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

function upstreamRef(upstream: string | undefined): string | undefined {
  if (upstream === undefined) {
    return undefined;
  }
  return upstream.startsWith("refs/") ? upstream : `refs/remotes/${upstream}`;
}

export class GitWorktreeAuditAdapter implements AuditAdapter {
  readonly id = "git";
  private readonly runGit: GitRunner;

  constructor(
    private readonly root: string | undefined,
    runGit: GitRunner | undefined = undefined,
    private readonly pathExists: GitPathExists = defaultPathExists,
    private readonly processProbe: GitProcessProbe = (path) => findProcessesUsingPath(path),
    private readonly reachability?: ReachabilityIndex,
    private readonly options: GitWorktreeOptions = DEFAULT_OPTIONS,
    private readonly dependencies: GitWorktreeDependencies = {},
  ) {
    const runner: GitRunner =
      runGit ??
      ((args, signal) => defaultGitRunner(args, this.options.gitTimeoutMs ?? 10_000, signal));
    this.runGit = async (args, signal) => {
      signal?.throwIfAborted();
      const output = await runner(args, signal);
      signal?.throwIfAborted();
      return output;
    };
  }

  async probe(context: AuditContext): Promise<AdapterProbe> {
    context.signal?.throwIfAborted();
    if (this.root === undefined) {
      return {
        adapter: this.id,
        status: "degraded",
        detail: "Git audit requires an explicit repository root",
        diagnostics: [
          {
            severity: "warning",
            code: "GIT_ROOT_REQUIRED",
            message: "Set adapters.git.root to an explicit repository.",
            adapter: this.id,
          },
        ],
      };
    }

    const requestedRoot = resolve(this.root);
    if (this.dependencies.discovery?.diagnostic !== undefined) {
      return {
        adapter: this.id,
        status: "degraded",
        root: requestedRoot,
        detail: "Git repository could not be inspected",
        diagnostics: [this.dependencies.discovery.diagnostic],
      };
    }
    if (this.dependencies.discovery?.records !== undefined) {
      return {
        adapter: this.id,
        status: "available",
        root: requestedRoot,
        detail: "Git repository found",
        diagnostics: [],
      };
    }
    try {
      const root = (
        await this.runGit(["-C", requestedRoot, "rev-parse", "--show-toplevel"], context.signal)
      ).trim();
      return {
        adapter: this.id,
        status: "available",
        root,
        detail: "Git repository found",
        diagnostics: [],
      };
    } catch (error) {
      context.signal?.throwIfAborted();
      return {
        adapter: this.id,
        status: "degraded",
        root: requestedRoot,
        detail: "Git repository could not be inspected",
        diagnostics: [
          {
            severity: "warning",
            code: "GIT_PROBE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          },
        ],
      };
    }
  }

  async collect(
    context: AuditContext,
    probe: AdapterProbe,
    observer?: CollectionObserver,
  ): Promise<CollectionResult> {
    const { signal } = context;
    signal?.throwIfAborted();
    const runGit = (args: string[]) => this.runGit(args, signal);
    if (probe.status !== "available" || probe.root === undefined) {
      if (this.dependencies.isolateRepositoryFailure !== true) {
        this.reachability?.protectUnresolvedGitRefs(context.now.toISOString());
      }
      return { resources: [], diagnostics: [] };
    }

    let records: readonly GitWorktreeRecord[];
    try {
      records =
        this.dependencies.discovery?.records ??
        parseWorktreePorcelain(
          await runGit(["-C", probe.root, "worktree", "list", "--porcelain", "-z"]),
        );
    } catch (error) {
      signal?.throwIfAborted();
      return this.repositoryFailure(context, error);
    }
    const mainWorktreePath = records[0] === undefined ? undefined : resolve(records[0].path);
    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const record of records) {
      signal?.throwIfAborted();
      if (
        this.dependencies.selectedPath !== undefined &&
        record.path !== this.dependencies.selectedPath
      )
        continue;
      let exists = true;
      let pathInspectionFailed = false;
      try {
        const stats = await (this.dependencies.inspect ?? lstat)(record.path);
        exists = stats.isDirectory() && !stats.isSymbolicLink();
      } catch (error) {
        signal?.throwIfAborted();
        if (isMissing(error)) {
          exists = false;
        } else {
          pathInspectionFailed = true;
          diagnostics.push({
            severity: "warning",
            code: "GIT_WORKTREE_INSPECTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          });
        }
      }

      signal?.throwIfAborted();
      const worktreePath = resolve(record.path);
      const canonicalKey = `git:git-worktree:${worktreePath}`;
      let inspectionComplete = exists && !pathInspectionFailed;
      let status: GitStatusFacts | undefined;
      let gitRefs: string[] = [];
      let gitRefInspectionComplete = true;
      let remotes: string[] = [];
      let remoteReachable = false;
      let remoteHistoryComplete = true;
      let repositoryCommonDir: string | undefined;
      let measurement: Measurement | undefined;
      let mountBoundaries: MountBoundaryResult = {
        status: "unknown",
        paths: [],
        reason: "worktree does not exist",
      };
      let hasSubmodules = false;
      let statusSuppressedEntries = 0;
      let stats: Awaited<ReturnType<typeof lstat>> | undefined;
      const operations = new Set<string>();
      let processOwnership: ProcessOwnershipResult = {
        status: "unknown",
        matches: [],
        reason: "worktree does not exist",
        scope: "path",
      };
      let processOwnershipDeferred = false;

      if (inspectionComplete) {
        try {
          stats = await (this.dependencies.inspect ?? lstat)(worktreePath);
          signal?.throwIfAborted();
          await realpath(worktreePath);
          status = parseGitStatusPorcelainV2(
            await runGit([
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
          remotes = lines(await runGit(["-C", worktreePath, "remote"]));
          const commonDirOutput = (
            await runGit([
              "-C",
              worktreePath,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])
          ).trim();
          repositoryCommonDir = resolve(worktreePath, commonDirOutput);
          hasSubmodules = (await runGit(["-C", worktreePath, "ls-files", "-z", "--stage"]))
            .split("\0")
            .some((entry) => entry.startsWith("160000 "));
          statusSuppressedEntries = countStatusSuppressedIndexEntries(
            await runGit(["-C", worktreePath, "ls-files", "-z", "-v"]),
          );
          if (this.options.measureBytes) {
            signal?.throwIfAborted();
            measurement = await (this.dependencies.measure ?? measurePath)(worktreePath, {
              maxEntries: this.options.maxEntries,
              excludeRootEntries: [".git"],
              ...(signal === undefined ? {} : { signal }),
            });
          }
          signal?.throwIfAborted();
          mountBoundaries = await (this.dependencies.mountProbe ?? findMountBoundaries)(
            worktreePath,
          );
          const head = status.head ?? record.head;
          if (head !== undefined) {
            const configuredPins =
              this.reachability?.activeGitRefs(context.now.toISOString()) ?? [];
            let matchingPins: string[] = [];
            try {
              matchingPins = await matchingGitRefPins(
                (args) => runGit(["-C", worktreePath, ...args]),
                head,
                configuredPins,
                { requireCompleteHistory: this.dependencies.selectedPath !== undefined },
              );
            } catch (error) {
              signal?.throwIfAborted();
              gitRefInspectionComplete = false;
              diagnostics.push({
                severity: "warning",
                code: "GIT_REF_PIN_INSPECTION_FAILED",
                message: error instanceof Error ? error.message : String(error),
                adapter: this.id,
              });
            }
            gitRefs = [
              record.branch,
              branchRef(status.branch),
              upstreamRef(status.upstream),
              ...matchingPins,
            ]
              .filter((value): value is string => value !== undefined)
              .filter((value, index, values) => values.indexOf(value) === index)
              .sort();
            remoteReachable = await isPushedHead((args) => runGit(["-C", worktreePath, ...args]), {
              head,
              ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
              ahead: status.ahead,
              remoteConfigured: remotes.length > 0,
              detached: record.detached,
            });
            if (
              this.dependencies.selectedPath !== undefined &&
              remotes.length > 0 &&
              !record.detached &&
              !remoteReachable
            ) {
              remoteHistoryComplete =
                (
                  await runGit(["-C", worktreePath, "rev-parse", "--is-shallow-repository"])
                ).trim() === "false";
            }
          } else {
            gitRefInspectionComplete = false;
          }
          for (const operation of await findGitOperations(worktreePath, runGit, (path) => {
            signal?.throwIfAborted();
            return this.pathExists(path);
          })) {
            operations.add(operation);
          }
          const stagedCount = status?.staged ?? 0;
          const modifiedCount = status?.modified ?? 0;
          const untrackedCount = status?.untracked ?? 0;
          const conflictedCount = status?.conflicted ?? 0;
          const ignoredCount = status?.ignored ?? 0;
          const ageMinutes =
            measurement === undefined
              ? undefined
              : Math.max(0, (context.now.getTime() - measurement.newestMtimeMs) / 60_000);
          const deferOwnership = shouldDeferProcessOwnership({
            isMain: worktreePath === mainWorktreePath,
            platform: this.options.platform,
            bare: record.bare,
            locked: record.locked,
            prunable: record.prunable,
            dirty:
              stagedCount + modifiedCount + untrackedCount + conflictedCount + ignoredCount > 0,
            ageMinutes,
            minAgeMinutes: this.options.minAgeMinutes,
          });
          if (deferOwnership) {
            // Cheap authoritative gates already protect this worktree; skip lsof.
            // Fail-closed: deferred idle is only used when other classify roots will fire.
            processOwnership = { status: "idle", matches: [] };
            processOwnershipDeferred = true;
          } else {
            signal?.throwIfAborted();
            processOwnership = await this.processProbe(worktreePath);
          }
          if (
            (!deferOwnership && processOwnership.status === "unknown") ||
            repositoryCommonDir === undefined ||
            stats === undefined
          ) {
            inspectionComplete = false;
          }
        } catch (error) {
          signal?.throwIfAborted();
          // Discovery succeeded: this failure belongs to one worktree, not its siblings.
          inspectionComplete = false;
          diagnostics.push({
            severity: "warning",
            code: "GIT_WORKTREE_INSPECTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          });
        }
      }
      signal?.throwIfAborted();
      this.reachability?.bindGitRefsToPath(
        worktreePath,
        gitRefs,
        context.now.toISOString(),
        gitRefInspectionComplete,
      );

      const localReachable = typeof status?.branch === "string" || record.branch !== undefined;
      const remoteConfigured = remotes.length > 0;
      const ahead = status?.ahead ?? 0;
      const staged = status?.staged ?? 0;
      const modified = status?.modified ?? 0;
      const untracked = status?.untracked ?? 0;
      const conflicted = status?.conflicted ?? 0;
      const ignored = status?.ignored ?? 0;
      resources.push({
        resource: {
          id: `git:git-worktree:${sha256(canonicalKey)}`,
          adapter: this.id,
          kind: "git-worktree",
          canonicalKey,
          displayName: worktreePath === mainWorktreePath ? "Main worktree" : "Linked worktree",
          path: worktreePath,
        },
        observedAt: context.now.toISOString(),
        exists,
        facts: {
          isMain: worktreePath === mainWorktreePath,
          head: status?.head ?? record.head,
          branch: status?.branch ?? record.branch,
          upstream: status?.upstream,
          gitRefs,
          ...(this.dependencies.selectedPath === undefined
            ? {}
            : { gitRefInspectionComplete, remoteHistoryComplete }),
          detached: record.detached,
          bare: record.bare,
          locked: record.locked,
          prunable: record.prunable,
          repositoryCommonDir,
          device: stats?.dev,
          inode: stats?.ino,
          mtimeMs: stats?.mtimeMs,
          newestMtimeMs: measurement?.newestMtimeMs,
          fingerprint: measurement?.fingerprint,
          measurementTruncated: measurement?.truncated ?? !this.options.measureBytes,
          specialEntries: measurement?.specialEntries,
          mountBoundaries: measurement?.mountBoundaries,
          mountBoundaryStatus: mountBoundaries.status,
          mountBoundaryPaths: mountBoundaries.paths,
          mountBoundaryReason:
            mountBoundaries.status === "unknown" ? mountBoundaries.reason : undefined,
          ageMinutes:
            measurement === undefined
              ? undefined
              : Math.max(0, (context.now.getTime() - measurement.newestMtimeMs) / 60_000),
          hasSubmodules,
          platform: this.options.platform,
          staged,
          modified,
          untracked,
          conflicted,
          ignored,
          statusSuppressedEntries,
          dirty: staged + modified + untracked + conflicted + ignored > 0,
          ahead,
          behind: status?.behind ?? 0,
          operations: [...operations].sort(),
          processOwnership: processOwnership.status,
          processMatches:
            processOwnership.status === "busy"
              ? processOwnership.matches.map((match) => ({
                  pid: match.pid,
                  source: match.source,
                }))
              : [],
          processReason:
            processOwnership.status === "unknown" ? processOwnership.reason : undefined,
          localReachable,
          remoteReachable,
          remoteConfigured,
          unpushed:
            status?.upstream !== undefined
              ? ahead > 0
              : remoteConfigured && !record.detached && !remoteReachable,
          remoteProof:
            status?.upstream !== undefined
              ? "configured-upstream"
              : remoteConfigured
                ? "local-remote-tracking-refs"
                : "unavailable",
          inspectionComplete,
          reportOnly: true,
          processOwnershipDeferred,
        },
        ...(measurement === undefined ? {} : { measuredBytes: measurement.bytes }),
      });
      observer?.reportResource(resources[resources.length - 1]!);
    }
    return { resources, diagnostics };
  }

  private repositoryFailure(
    context: AuditContext,
    error: unknown,
    diagnostics: readonly Diagnostic[] = [],
  ): CollectionResult {
    if (this.dependencies.isolateRepositoryFailure !== true) {
      this.reachability?.protectUnresolvedGitRefs(context.now.toISOString());
    }
    return {
      resources: [],
      diagnostics: [
        ...diagnostics,
        {
          severity: "warning",
          code: "GIT_REPOSITORY_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        },
      ],
    };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const observedAt = context.now.toISOString();
    const roots = worktreeProtectionRoots(
      resource,
      observedAt,
      this.options.minAgeMinutes,
      this.reachability,
    );
    const eligible = resource.exists && roots.length === 0;
    const candidateActions: WorktreeQuarantineAction[] =
      eligible && this.dependencies.selectedPath === undefined ? [this.actionFor(resource)] : [];

    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state: eligible
        ? "eligible"
        : resource.exists && resource.facts.inspectionComplete === true
          ? "protected"
          : "unknown",
      confidence:
        resource.exists && resource.facts.inspectionComplete === true ? "certain" : "unknown",
      roots,
      facts: resource.facts,
      candidateActions,
      ...(resource.measuredBytes === undefined
        ? {}
        : {
            measuredBytes: resource.measuredBytes,
            estimatedReclaimBytes: 0,
          }),
      warnings: [],
    };
  }

  private actionFor(resource: ResourceSnapshot): WorktreeQuarantineAction {
    const facts = resource.facts;
    const branch =
      typeof facts.branch === "string" ? (branchRef(facts.branch) ?? facts.branch) : undefined;
    const target = {
      path: resource.resource.path!,
      repositoryCommonDir: String(facts.repositoryCommonDir),
      head: String(facts.head),
      ...(branch === undefined ? {} : { branch }),
      device: Number(facts.device),
      inode: Number(facts.inode),
      mtimeMs: Number(facts.mtimeMs),
      measuredBytes: resource.measuredBytes!,
      newestMtimeMs: Number(facts.newestMtimeMs),
      fingerprint: String(facts.fingerprint),
    };

    return {
      actionId: `worktree.quarantine:${sha256(JSON.stringify(target))}`,
      type: "worktree.quarantine",
      adapter: "git",
      resourceId: resource.resource.id,
      risk: "recoverable",
      description: `Quarantine inactive linked worktree ${target.path}`,
      expectedReclaimBytes: 0,
      pendingQuarantineBytes: target.measuredBytes,
      quarantineTtlMinutes: this.options.quarantineTtlMinutes,
      target,
    };
  }
}
