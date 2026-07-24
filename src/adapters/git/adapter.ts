import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { AgentRinseConfig } from "../../config/schema.js";
import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import type { WorktreeQuarantineAction } from "../../contracts/action.js";
import type { Diagnostic } from "../../contracts/diagnostic.js";
import type { Finding, RootEvidence } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import { measurePath, type Measurement } from "../../core/measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "../../core/mount-boundaries.js";
import {
  findProcessesUsingPath,
  type ProcessOwnershipResult,
} from "../../core/process-ownership.js";
import type { ReachabilityIndex } from "../../core/reachability.js";
import { parseWorktreePorcelain } from "./porcelain.js";
import { parseGitStatusPorcelainV2, type GitStatusFacts } from "./status.js";

const execFileAsync = promisify(execFile);
const OPERATION_MARKERS = [
  ["merge", "MERGE_HEAD"],
  ["rebase", "rebase-merge"],
  ["rebase", "rebase-apply"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
  ["bisect", "BISECT_LOG"],
] as const;

export type GitRunner = (args: string[]) => Promise<string>;
export type GitPathExists = (path: string) => Promise<boolean>;
export type GitProcessProbe = (path: string) => Promise<ProcessOwnershipResult>;
export type GitWorktreeOptions = AgentRinseConfig["audit"] &
  AgentRinseConfig["worktrees"] & {
    platform: NodeJS.Platform;
  };
export type GitWorktreeDependencies = {
  measure?: typeof measurePath;
  mountProbe?: (path: string) => Promise<MountBoundaryResult>;
};

const DEFAULT_OPTIONS: GitWorktreeOptions = {
  maxEntries: 100_000,
  measureBytes: true,
  minAgeMinutes: 14 * 24 * 60,
  quarantineTtlMinutes: 7 * 24 * 60,
  platform: process.platform,
};

async function defaultGitRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
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

  constructor(
    private readonly root: string | undefined,
    private readonly runGit: GitRunner = defaultGitRunner,
    private readonly pathExists: GitPathExists = defaultPathExists,
    private readonly processProbe: GitProcessProbe = (path) => findProcessesUsingPath(path),
    private readonly reachability?: ReachabilityIndex,
    private readonly options: GitWorktreeOptions = DEFAULT_OPTIONS,
    private readonly dependencies: GitWorktreeDependencies = {},
  ) {}

  async probe(_context: AuditContext): Promise<AdapterProbe> {
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
    try {
      const root = (
        await this.runGit(["-C", requestedRoot, "rev-parse", "--show-toplevel"])
      ).trim();
      return {
        adapter: this.id,
        status: "available",
        root,
        detail: "Git repository found",
        diagnostics: [],
      };
    } catch (error) {
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

  async collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult> {
    if (probe.status !== "available" || probe.root === undefined) {
      this.reachability?.protectUnresolvedGitRefs(context.now.toISOString());
      return { resources: [], diagnostics: [] };
    }

    const output = await this.runGit(["-C", probe.root, "worktree", "list", "--porcelain", "-z"]);
    const records = parseWorktreePorcelain(output);
    const mainWorktreePath = records[0] === undefined ? undefined : resolve(records[0].path);
    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const record of records) {
      let exists = true;
      try {
        const stats = await lstat(record.path);
        exists = stats.isDirectory() && !stats.isSymbolicLink();
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        exists = false;
      }

      const worktreePath = resolve(record.path);
      const canonicalKey = `git:git-worktree:${worktreePath}`;
      let inspectionComplete = exists;
      let status: GitStatusFacts | undefined;
      let containingRefs: string[] = [];
      let gitRefs: string[] = [];
      let gitRefInspectionComplete = false;
      let remotes: string[] = [];
      let repositoryCommonDir: string | undefined;
      let measurement: Measurement | undefined;
      let mountBoundaries: MountBoundaryResult = {
        status: "unknown",
        paths: [],
        reason: "worktree does not exist",
      };
      let hasSubmodules = false;
      let stats: Awaited<ReturnType<typeof lstat>> | undefined;
      const operations = new Set<string>();
      let processOwnership: ProcessOwnershipResult = {
        status: "unknown",
        matches: [],
        reason: "worktree does not exist",
      };

      if (exists) {
        try {
          stats = await lstat(worktreePath);
          await realpath(worktreePath);
          status = parseGitStatusPorcelainV2(
            await this.runGit([
              "-C",
              worktreePath,
              "status",
              "--porcelain=v2",
              "--branch",
              "-z",
              "--untracked-files=all",
            ]),
          );
          remotes = lines(await this.runGit(["-C", worktreePath, "remote"]));
          const commonDirOutput = (
            await this.runGit([
              "-C",
              worktreePath,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])
          ).trim();
          repositoryCommonDir = resolve(worktreePath, commonDirOutput);
          hasSubmodules = (await this.runGit(["-C", worktreePath, "ls-files", "-z", "--stage"]))
            .split("\0")
            .some((entry) => entry.startsWith("160000 "));
          if (this.options.measureBytes) {
            measurement = await (this.dependencies.measure ?? measurePath)(worktreePath, {
              maxEntries: this.options.maxEntries,
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            });
          }
          mountBoundaries = await (this.dependencies.mountProbe ?? findMountBoundaries)(
            worktreePath,
          );
          const head = status.head ?? record.head;
          if (head !== undefined) {
            containingRefs = lines(
              await this.runGit([
                "-C",
                worktreePath,
                "for-each-ref",
                "--contains",
                head,
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes",
              ]),
            );
            const tagRefs = lines(
              await this.runGit([
                "-C",
                worktreePath,
                "for-each-ref",
                "--points-at",
                head,
                "--format=%(refname)",
                "refs/tags",
              ]),
            );
            gitRefs = [
              record.branch,
              branchRef(status.branch),
              upstreamRef(status.upstream),
              ...tagRefs,
            ]
              .filter((value): value is string => value !== undefined)
              .filter((value, index, values) => values.indexOf(value) === index)
              .sort();
            gitRefInspectionComplete = true;
          }
          for (const [operation, marker] of OPERATION_MARKERS) {
            const reportedMarkerPath = (
              await this.runGit(["-C", worktreePath, "rev-parse", "--git-path", marker])
            ).trim();
            const markerPath =
              reportedMarkerPath === "" || isAbsolute(reportedMarkerPath)
                ? reportedMarkerPath
                : resolve(worktreePath, reportedMarkerPath);
            if (markerPath !== "" && (await this.pathExists(markerPath))) {
              operations.add(operation);
            }
          }
          processOwnership = await this.processProbe(worktreePath);
          if (
            processOwnership.status === "unknown" ||
            repositoryCommonDir === undefined ||
            stats === undefined
          ) {
            inspectionComplete = false;
          }
        } catch (error) {
          inspectionComplete = false;
          diagnostics.push({
            severity: "warning",
            code: "GIT_WORKTREE_INSPECTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          });
        }
      }
      this.reachability?.bindGitRefsToPath(
        worktreePath,
        gitRefs,
        context.now.toISOString(),
        gitRefInspectionComplete,
      );

      const localReachable = containingRefs.some((ref) => ref.startsWith("refs/heads/"));
      const remoteReachable = containingRefs.some((ref) => ref.startsWith("refs/remotes/"));
      const remoteConfigured = remotes.length > 0;
      const ahead = status?.ahead ?? 0;
      const staged = status?.staged ?? 0;
      const modified = status?.modified ?? 0;
      const untracked = status?.untracked ?? 0;
      const conflicted = status?.conflicted ?? 0;
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
          dirty: staged + modified + untracked + conflicted > 0,
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
          unpushed: ahead > 0 || (remoteConfigured && localReachable && !remoteReachable),
          remoteProof: remoteConfigured ? "local-remote-tracking-refs" : "unavailable",
          inspectionComplete,
          reportOnly: true,
        },
        ...(measurement === undefined ? {} : { measuredBytes: measurement.bytes }),
      });
    }
    if (records.length === 0) {
      this.reachability?.protectUnresolvedGitRefs(context.now.toISOString());
    }

    return { resources, diagnostics };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const observedAt = context.now.toISOString();
    const roots: RootEvidence[] = [];

    if (resource.facts.isMain === true) {
      roots.push({
        code: "main-worktree",
        source: "git",
        observedAt,
        detail: "The main worktree is always protected.",
      });
    }

    if (!["darwin", "linux"].includes(String(resource.facts.platform))) {
      roots.push({
        code: "worktree-mutation-unsupported",
        source: "git",
        observedAt,
        detail: "Recoverable worktree quarantine is supported only on macOS and Linux.",
      });
    }
    if (resource.facts.bare === true || resource.facts.prunable !== undefined) {
      roots.push({
        code: "worktree-registration-unsafe",
        source: "git",
        observedAt,
        detail: "Bare or prunable worktree registrations are not quarantine candidates.",
      });
    }
    if (resource.facts.locked !== undefined) {
      roots.push({
        code: "git-lock",
        source: "git",
        observedAt,
        detail: "Git reports this worktree as locked.",
      });
    }

    if (resource.facts.dirty === true) {
      roots.push({
        code: "dirty-worktree",
        source: "git",
        observedAt,
        detail: "Git reports staged, modified, conflicted, or untracked work.",
      });
    }
    if (Array.isArray(resource.facts.operations) && resource.facts.operations.length > 0) {
      roots.push({
        code: "git-operation-in-progress",
        source: "git",
        observedAt,
        detail: `Git operation in progress: ${resource.facts.operations.join(", ")}.`,
      });
    }
    if (resource.facts.unpushed === true) {
      roots.push({
        code: "unpushed-commit",
        source: "git",
        observedAt,
        detail: "The worktree HEAD is ahead of or absent from local remote-tracking refs.",
      });
    }
    if (resource.facts.processOwnership === "busy") {
      roots.push({
        code: "live-process-worktree",
        source: "process",
        observedAt,
        detail: "A live process has its CWD or an open file inside this worktree.",
      });
    }
    if (resource.facts.processOwnership === "unknown") {
      roots.push({
        code: "process-ownership-incomplete",
        source: "process",
        observedAt,
        detail: "Live process ownership could not be proven completely.",
      });
    }
    if (resource.facts.remoteConfigured !== true) {
      roots.push({
        code: "unknown-remote",
        source: "git",
        observedAt,
        detail: "No configured remote is available for reachability proof.",
      });
    }
    if (resource.facts.detached === true) {
      roots.push({
        code: "detached-worktree",
        source: "git",
        observedAt,
        detail: "Detached worktrees are outside the 0.3 quarantine boundary.",
      });
    }
    if (
      typeof resource.facts.head !== "string" ||
      typeof resource.facts.branch !== "string" ||
      typeof resource.facts.repositoryCommonDir !== "string"
    ) {
      roots.push({
        code: "worktree-identity-incomplete",
        source: "git",
        observedAt,
        detail: "Worktree HEAD, branch, or common Git directory could not be proven.",
      });
    }
    if (resource.facts.hasSubmodules === true) {
      roots.push({
        code: "worktree-submodules",
        source: "git",
        observedAt,
        detail: "Worktrees containing gitlink entries are not quarantine candidates.",
      });
    }
    if (
      resource.measuredBytes === undefined ||
      resource.facts.measurementTruncated === true ||
      typeof resource.facts.fingerprint !== "string"
    ) {
      roots.push({
        code: "worktree-measurement-incomplete",
        source: "git",
        observedAt,
        detail: "Worktree contents could not be measured completely.",
      });
    }
    if (
      (typeof resource.facts.specialEntries === "number" && resource.facts.specialEntries > 0) ||
      (typeof resource.facts.mountBoundaries === "number" && resource.facts.mountBoundaries > 0) ||
      resource.facts.mountBoundaryStatus === "blocked"
    ) {
      roots.push({
        code: "worktree-filesystem-boundary",
        source: "git",
        observedAt,
        detail: "Worktree contents include an unsupported filesystem entry or mount boundary.",
      });
    }
    if (resource.facts.mountBoundaryStatus !== "clear") {
      roots.push({
        code: "worktree-mount-inspection-incomplete",
        source: "git",
        observedAt,
        detail: "Filesystem mount boundaries could not be proven absent.",
      });
    }
    if (
      typeof resource.facts.ageMinutes !== "number" ||
      resource.facts.ageMinutes < this.options.minAgeMinutes
    ) {
      roots.push({
        code: "recent-resource",
        source: "git",
        observedAt,
        detail: `Worktree is newer than ${this.options.minAgeMinutes} minutes.`,
      });
    }
    if (resource.facts.inspectionComplete !== true) {
      roots.push({
        code: "git-inspection-incomplete",
        source: "git",
        observedAt,
        detail: "Git state or reachability could not be proven completely.",
      });
    }
    roots.push(
      ...(this.reachability?.rootsForResource(resource.resource, resource.facts, observedAt) ?? []),
    );
    roots.sort((left, right) => left.code.localeCompare(right.code));
    const eligible = resource.exists && roots.length === 0;
    const candidateActions: WorktreeQuarantineAction[] = eligible ? [this.actionFor(resource)] : [];

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
