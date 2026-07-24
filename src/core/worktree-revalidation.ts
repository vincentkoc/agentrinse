import { createAuditAdapters } from "../adapters/registry.js";
import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { WorktreeQuarantineAction } from "../contracts/action.js";
import type { AuditContext } from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { RootEvidence } from "../contracts/finding.js";
import type { AuditReport } from "../contracts/report.js";
import type { ResourceRef } from "../contracts/resource.js";
import { ReachabilityIndex } from "./reachability.js";
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

export async function currentWorktreeProtectionRoots(
  action: WorktreeQuarantineAction,
  home: string,
  config: AgentRinseConfig,
  now: Date,
): Promise<RootEvidence[]> {
  const reachability = new ReachabilityIndex();
  const adapters = createAuditAdapters(config, process.platform, {
    providerInventory: false,
    reachability,
  }).filter((adapter) => Object.hasOwn(PROVIDER_SPECS, adapter.id));
  const context: AuditContext = {
    home,
    now,
    auditId: `apply-${action.actionId}`,
  };
  for (const adapter of adapters) {
    const probe = await adapter.probe(context);
    await adapter.collect(context, probe);
  }

  const resource: ResourceRef = {
    id: action.resourceId,
    adapter: "git",
    kind: "git-worktree",
    canonicalKey: `git:git-worktree:${action.target.path}`,
    displayName: "Linked worktree",
    path: action.target.path,
  };
  const observedAt = now.toISOString();
  const facts =
    action.target.branch === undefined
      ? {}
      : { branch: action.target.branch, gitRefs: [action.target.branch] };
  const roots = [
    ...reachability.rootsForResource(resource, facts, observedAt),
    ...reachability.rootsFor(action.target.path, observedAt),
  ];
  return [
    ...new Map(
      roots.map((root) => [
        `${root.code}\0${root.source}\0${root.evidenceRef ?? ""}\0${root.detail}`,
        root,
      ]),
    ).values(),
  ];
}

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
