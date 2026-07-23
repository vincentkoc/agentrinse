import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import type { Finding, RootEvidence } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import { parseWorktreePorcelain } from "./porcelain.js";

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<string>;

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

export class GitWorktreeAuditAdapter implements AuditAdapter {
  readonly id = "git";

  constructor(
    private readonly root: string | undefined,
    private readonly runGit: GitRunner = defaultGitRunner,
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
            message: "Set adapters.git.root to a synthetic repository.",
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

      const canonicalKey = `git:git-worktree:${resolve(record.path)}`;
      resources.push({
        resource: {
          id: `git:git-worktree:${sha256(canonicalKey)}`,
          adapter: this.id,
          kind: "git-worktree",
          canonicalKey,
          displayName: record.path === probe.root ? "Main worktree" : "Linked worktree",
          path: resolve(record.path),
        },
        observedAt: context.now.toISOString(),
        exists,
        facts: {
          isMain: resolve(record.path) === resolve(probe.root),
          head: record.head,
          branch: record.branch,
          detached: record.detached,
          bare: record.bare,
          locked: record.locked,
          prunable: record.prunable,
          reportOnly: true,
        },
      });
    }

    return { resources, diagnostics: [] };
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

    roots.push({
      code: "git-audit-only",
      source: "git",
      observedAt,
      detail:
        "The pre-alpha Git adapter does not yet prove dirty, process, session, or push state.",
    });

    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state: resource.exists ? "protected" : "unknown",
      confidence: resource.exists ? "certain" : "unknown",
      roots,
      facts: resource.facts,
      candidateActions: [],
      warnings: [],
    };
  }
}
