import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import type { Diagnostic } from "../../contracts/diagnostic.js";
import type { Finding, RootEvidence } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
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

export class GitWorktreeAuditAdapter implements AuditAdapter {
  readonly id = "git";

  constructor(
    private readonly root: string | undefined,
    private readonly runGit: GitRunner = defaultGitRunner,
    private readonly pathExists: GitPathExists = defaultPathExists,
    private readonly processProbe: GitProcessProbe = (path) => findProcessesUsingPath(path),
    private readonly reachability?: ReachabilityIndex,
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
      return { resources: [], diagnostics: [] };
    }

    const output = await this.runGit(["-C", probe.root, "worktree", "list", "--porcelain", "-z"]);
    const records = parseWorktreePorcelain(output);
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
      let remotes: string[] = [];
      const operations = new Set<string>();
      let processOwnership: ProcessOwnershipResult = {
        status: "unknown",
        matches: [],
        reason: "worktree does not exist",
      };

      if (exists) {
        try {
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
          }
          for (const [operation, marker] of OPERATION_MARKERS) {
            const markerPath = (
              await this.runGit(["-C", worktreePath, "rev-parse", "--git-path", marker])
            ).trim();
            if (markerPath !== "" && (await this.pathExists(markerPath))) {
              operations.add(operation);
            }
          }
          processOwnership = await this.processProbe(worktreePath);
          if (processOwnership.status === "unknown") {
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
          displayName: record.path === probe.root ? "Main worktree" : "Linked worktree",
          path: worktreePath,
        },
        observedAt: context.now.toISOString(),
        exists,
        facts: {
          isMain: worktreePath === resolve(probe.root),
          head: status?.head ?? record.head,
          branch: status?.branch ?? record.branch,
          upstream: status?.upstream,
          detached: record.detached,
          bare: record.bare,
          locked: record.locked,
          prunable: record.prunable,
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
      });
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
    if (
      resource.facts.detached === true &&
      resource.facts.localReachable !== true &&
      resource.facts.remoteReachable !== true
    ) {
      roots.push({
        code: "unreachable-detached-commit",
        source: "git",
        observedAt,
        detail: "The detached HEAD is not contained by a local or remote-tracking ref.",
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
    if (resource.resource.path !== undefined) {
      roots.push(...(this.reachability?.rootsFor(resource.resource.path, observedAt) ?? []));
    }
    roots.push({
      code: "worktree-removal-unavailable",
      source: "git",
      observedAt,
      detail: "AgentRinse 0.2 reports reachability but does not remove worktrees.",
    });
    roots.sort((left, right) => left.code.localeCompare(right.code));

    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state:
        resource.exists && resource.facts.inspectionComplete === true ? "protected" : "unknown",
      confidence:
        resource.exists && resource.facts.inspectionComplete === true ? "certain" : "unknown",
      roots,
      facts: resource.facts,
      candidateActions: [],
      warnings: [],
    };
  }
}
