import { createAuditAdapters } from "../adapters/registry.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { WorktreeQuarantineAction } from "../contracts/action.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { AuditReport } from "../contracts/report.js";
import { runAudit } from "./audit.js";

export type WorktreeRevalidationResult =
  | {
      status: "valid";
      report: AuditReport;
      action: WorktreeQuarantineAction;
    }
  | { status: "stale"; diagnostic: Diagnostic };

export type WorktreeRevalidationDependencies = {
  now?: () => Date;
  platform?: NodeJS.Platform;
  audit?: (options: {
    home: string;
    config: AgentRinseConfig;
    platform: NodeJS.Platform;
  }) => Promise<AuditReport>;
};

function stale(
  action: WorktreeQuarantineAction,
  code: string,
  message: string,
): WorktreeRevalidationResult {
  return {
    status: "stale",
    diagnostic: {
      severity: "warning",
      code,
      message,
      adapter: action.adapter,
      resourceId: action.resourceId,
    },
  };
}

export async function revalidateWorktreeQuarantine(
  action: WorktreeQuarantineAction,
  home: string,
  config: AgentRinseConfig,
  dependencies: WorktreeRevalidationDependencies = {},
): Promise<WorktreeRevalidationResult> {
  const platform = dependencies.platform ?? process.platform;
  if (!["darwin", "linux"].includes(platform)) {
    return stale(
      action,
      "WORKTREE_PLATFORM_UNSUPPORTED",
      `recoverable worktree quarantine is unsupported on ${platform}`,
    );
  }

  try {
    const report =
      dependencies.audit === undefined
        ? await runAudit({
            home,
            config,
            adapters: createAuditAdapters(config, platform),
            ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
          })
        : await dependencies.audit({ home, config, platform });
    const finding = report.findings.find(
      (candidate) => candidate.resource.id === action.resourceId,
    );
    const refreshed = finding?.candidateActions.find(
      (candidate): candidate is WorktreeQuarantineAction =>
        candidate.type === "worktree.quarantine" && candidate.actionId === action.actionId,
    );

    if (finding?.state !== "eligible" || refreshed === undefined) {
      const reason =
        finding === undefined
          ? "the planned worktree is no longer discoverable"
          : finding.roots.length > 0
            ? finding.roots.map((root) => root.code).join(", ")
            : `the worktree state is ${finding.state}`;
      return stale(
        action,
        "WORKTREE_ELIGIBILITY_CHANGED",
        `worktree is no longer eligible for quarantine: ${reason}`,
      );
    }
    if (JSON.stringify(refreshed) !== JSON.stringify(action)) {
      return stale(
        action,
        "WORKTREE_IDENTITY_CHANGED",
        "worktree identity or quarantine policy changed after planning",
      );
    }

    return { status: "valid", report, action: refreshed };
  } catch (error) {
    return stale(
      action,
      "WORKTREE_REVALIDATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}
