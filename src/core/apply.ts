import { randomUUID } from "node:crypto";

import { agentRinseConfigSchema, type AgentRinseConfig } from "../config/schema.js";
import type { ArtifactRemoveAction, WorktreeQuarantineAction } from "../contracts/action.js";
import type { CleanupPlan } from "../contracts/plan.js";
import type { CleanupRun } from "../contracts/run.js";
import { acquireApplyLock } from "../state/lock.js";
import { stateLayout } from "../state/layout.js";
import { ensurePrivateDirectory } from "../state/json-file.js";
import { createRunJournal } from "../state/run-journal.js";
import {
  ArtifactExecutionError,
  artifactIsolationPath,
  executeArtifactRemove,
  type ArtifactExecutionResult,
} from "./artifact-executor.js";
import {
  revalidateArtifactRemove,
  type ArtifactRevalidationResult,
} from "./artifact-revalidation.js";
import { sha256 } from "./digest.js";
import { CommandInterruptedError } from "./interruption.js";
import { verifyCleanupPlan } from "./plan-verification.js";
import { isPathInside, resolvePhysicalPath } from "./safety.js";
import {
  executeWorktreeQuarantine,
  WorktreeExecutionError,
  worktreeQuarantinePath,
  worktreeRecoveryRef,
  type ExecuteWorktreeQuarantineOptions,
  type WorktreeExecutionResult,
} from "./worktree-executor.js";
import {
  currentWorktreeProtectionRoots,
  revalidateWorktreeQuarantine,
  type WorktreeRevalidationResult,
} from "./worktree-revalidation.js";
import type { RootEvidence } from "../contracts/finding.js";

export class ApplySafetyError extends Error {
  override readonly name = "ApplySafetyError";
}

export type ApplyResult = {
  plan: CleanupPlan;
  run: CleanupRun;
  journalPath: string;
};

export type ApplyDependencies = {
  clock?: () => Date;
  createJournal?: typeof createRunJournal;
  loadCurrentConfig?: () => Promise<AgentRinseConfig>;
  revalidate?: (
    action: ArtifactRemoveAction,
    home: string,
    config: AgentRinseConfig,
  ) => Promise<ArtifactRevalidationResult>;
  execute?: (action: ArtifactRemoveAction, isolationId: string) => Promise<ArtifactExecutionResult>;
  revalidateWorktree?: (
    action: WorktreeQuarantineAction,
    home: string,
    config: AgentRinseConfig,
  ) => Promise<WorktreeRevalidationResult>;
  executeWorktree?: (
    action: WorktreeQuarantineAction,
    options: ExecuteWorktreeQuarantineOptions,
  ) => Promise<WorktreeExecutionResult>;
  worktreeProtectionRoots?: (
    action: WorktreeQuarantineAction,
    home: string,
    config: AgentRinseConfig,
    now: Date,
  ) => Promise<RootEvidence[]>;
};

export type ApplyCleanupPlanOptions = {
  input: unknown;
  config: AgentRinseConfig;
  stateRoot: string;
  signal?: AbortSignal;
  dependencies?: ApplyDependencies;
};

function throwIfInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) {
    return;
  }
  throw signal.reason instanceof CommandInterruptedError
    ? signal.reason
    : new CommandInterruptedError("apply interrupted");
}

export async function applyCleanupPlan(options: ApplyCleanupPlanOptions): Promise<ApplyResult> {
  throwIfInterrupted(options.signal);
  const clock = options.dependencies?.clock ?? (() => new Date());
  const config = agentRinseConfigSchema.parse(options.config);
  const plan = verifyCleanupPlan(options.input, config, clock());
  const layout = stateLayout(options.stateRoot);
  const physicalStateRoot = await resolvePhysicalPath(layout.root);
  for (const action of plan.actions) {
    const physicalTarget = await resolvePhysicalPath(action.target.path);
    if (
      isPathInside(action.target.path, layout.root) ||
      isPathInside(physicalTarget, physicalStateRoot)
    ) {
      throw new ApplySafetyError(
        `state directory ${layout.root} must not be inside cleanup target ${action.target.path}`,
      );
    }
  }
  const runId = randomUUID();
  await ensurePrivateDirectory(layout.root);
  await ensurePrivateDirectory(layout.locks);
  await ensurePrivateDirectory(layout.runs);
  await ensurePrivateDirectory(layout.quarantine);
  const lock = await acquireApplyLock(layout.locks, {
    planId: plan.planId,
    runId,
    command: "agentrinse apply",
  });

  let journal: Awaited<ReturnType<typeof createRunJournal>> | undefined;
  try {
    journal = await (options.dependencies?.createJournal ?? createRunJournal)(
      layout.runs,
      plan,
      clock(),
      runId,
    );
    throwIfInterrupted(options.signal);

    for (const action of plan.actions) {
      throwIfInterrupted(options.signal);
      const startedAt = clock().toISOString();
      await journal.updateAction(action.actionId, {
        status: "revalidating",
        startedAt,
      });
      throwIfInterrupted(options.signal);

      const revalidation =
        action.type === "artifacts.remove"
          ? options.dependencies?.revalidate === undefined
            ? await revalidateArtifactRemove(action, plan.home, config, { now: clock })
            : await options.dependencies.revalidate(action, plan.home, config)
          : options.dependencies?.revalidateWorktree === undefined
            ? await revalidateWorktreeQuarantine(action, plan.home, config, { now: clock })
            : await options.dependencies.revalidateWorktree(action, plan.home, config);
      if (revalidation.status === "stale") {
        await journal.updateAction(action.actionId, {
          status: "skipped-stale",
          completedAt: clock().toISOString(),
          diagnostic: revalidation.diagnostic,
        });
        throwIfInterrupted(options.signal);
        continue;
      }
      throwIfInterrupted(options.signal);

      const authorizationCheckedAt = clock();
      if (authorizationCheckedAt.getTime() >= Date.parse(plan.expiresAt)) {
        await journal.updateAction(action.actionId, {
          status: "skipped-stale",
          completedAt: authorizationCheckedAt.toISOString(),
          diagnostic: {
            severity: "warning",
            code: "PLAN_EXPIRED_DURING_APPLY",
            message: `cleanup plan authorization expired at ${plan.expiresAt}`,
            adapter: action.adapter,
            resourceId: action.resourceId,
          },
        });
        throwIfInterrupted(options.signal);
        continue;
      }

      const isolationId = `${runId}-${sha256(action.actionId).slice(0, 12)}`;
      if (action.type === "artifacts.remove") {
        const isolationPath = artifactIsolationPath(action, isolationId);
        await journal.updateAction(action.actionId, {
          status: "applying",
          isolationPath,
        });
        throwIfInterrupted(options.signal);

        let result: ArtifactExecutionResult;
        try {
          result = await (
            options.dependencies?.execute ??
            ((selectedAction, selectedIsolationId) =>
              executeArtifactRemove(selectedAction, {
                id: () => selectedIsolationId,
                maxEntries: config.audit.maxEntries,
                authorization: {
                  expiresAtMs: Date.parse(plan.expiresAt),
                  now: clock,
                },
              }))
          )(action, isolationId);
        } catch (error) {
          const executionError = error instanceof ArtifactExecutionError ? error : undefined;
          await journal.updateAction(action.actionId, {
            status: executionError?.outcome ?? "failed",
            completedAt: clock().toISOString(),
            isolationPath: executionError?.isolationPath ?? isolationPath,
            diagnostic: {
              severity: executionError?.outcome === "skipped-stale" ? "warning" : "error",
              code:
                executionError?.diagnosticCode ??
                (executionError?.outcome === "skipped-stale"
                  ? "ARTIFACT_IDENTITY_CHANGED"
                  : executionError?.outcome === "partially-applied"
                    ? "ARTIFACT_PARTIALLY_APPLIED"
                    : executionError?.outcome === "rolled-back"
                      ? "ARTIFACT_ROLLED_BACK"
                      : "ARTIFACT_APPLY_FAILED"),
              message: error instanceof Error ? error.message : String(error),
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          });
          if (executionError?.outcome === "skipped-stale") {
            throwIfInterrupted(options.signal);
            continue;
          }
          break;
        }

        await journal.updateAction(action.actionId, {
          status: "applied",
          completedAt: clock().toISOString(),
          reclaimedBytes: result.reclaimedBytes,
          isolationPath: result.isolationPath,
        });
      } else {
        const quarantinePath = worktreeQuarantinePath(action, isolationId);
        const recoveryRef = worktreeRecoveryRef(action, runId);
        await journal.updateAction(action.actionId, {
          status: "applying",
          quarantineEntryId: isolationId,
          quarantinePath,
          recoveryRef,
        });
        throwIfInterrupted(options.signal);

        let result: WorktreeExecutionResult;
        try {
          result = await (
            options.dependencies?.executeWorktree ??
            ((selectedAction, selectedOptions) =>
              executeWorktreeQuarantine(selectedAction, selectedOptions))
          )(action, {
            runId,
            entryId: isolationId,
            quarantineDirectory: layout.quarantine,
            dependencies: {
              clock,
              maxEntries: config.audit.maxEntries,
              authorization: {
                expiresAtMs: Date.parse(plan.expiresAt),
                now: clock,
              },
              revalidateProtection: async () => {
                const currentConfig =
                  options.dependencies?.loadCurrentConfig === undefined
                    ? undefined
                    : agentRinseConfigSchema.parse(await options.dependencies.loadCurrentConfig());
                const protectionConfigs =
                  currentConfig === undefined ? [config] : [config, currentConfig];
                const roots = (
                  await Promise.all(
                    protectionConfigs.map((protectionConfig) =>
                      (
                        options.dependencies?.worktreeProtectionRoots ??
                        currentWorktreeProtectionRoots
                      )(action, plan.home, protectionConfig, clock()),
                    ),
                  )
                ).flat();
                if (roots.length > 0) {
                  const codes = [...new Set(roots.map((root) => root.code))].sort();
                  throw new ApplySafetyError(
                    `worktree is protected at quarantine boundary: ${codes.join(", ")}`,
                  );
                }
              },
            },
          });
        } catch (error) {
          const executionError = error instanceof WorktreeExecutionError ? error : undefined;
          await journal.updateAction(action.actionId, {
            status: executionError?.outcome ?? "failed",
            completedAt: clock().toISOString(),
            quarantineEntryId: executionError?.entry?.entryId ?? isolationId,
            quarantinePath: executionError?.entry?.quarantinePath ?? quarantinePath,
            recoveryRef: executionError?.entry?.recoveryRef ?? recoveryRef,
            quarantinedBytes:
              executionError?.outcome === "partially-applied"
                ? (executionError.quarantinedBytes ?? 0)
                : 0,
            diagnostic: {
              severity: executionError?.outcome === "skipped-stale" ? "warning" : "error",
              code:
                executionError?.diagnosticCode ??
                (executionError?.outcome === "skipped-stale"
                  ? "WORKTREE_IDENTITY_CHANGED"
                  : executionError?.outcome === "partially-applied"
                    ? "WORKTREE_QUARANTINE_PARTIAL"
                    : executionError?.outcome === "rolled-back"
                      ? "WORKTREE_QUARANTINE_ROLLED_BACK"
                      : "WORKTREE_QUARANTINE_FAILED"),
              message: error instanceof Error ? error.message : String(error),
              adapter: action.adapter,
              resourceId: action.resourceId,
            },
          });
          if (executionError?.outcome === "skipped-stale") {
            throwIfInterrupted(options.signal);
            continue;
          }
          break;
        }

        await journal.updateAction(action.actionId, {
          status: "applied",
          completedAt: clock().toISOString(),
          reclaimedBytes: 0,
          quarantinedBytes: result.quarantinedBytes,
          quarantineEntryId: result.quarantineEntryId,
          quarantinePath: result.quarantinePath,
          recoveryRef: result.recoveryRef,
        });
      }
      throwIfInterrupted(options.signal);
    }

    const run = await journal.complete(clock());
    if (run.status === "completed") {
      throwIfInterrupted(options.signal);
    }
    return { plan, run, journalPath: journal.path };
  } catch (error) {
    if (error instanceof CommandInterruptedError && journal !== undefined) {
      const run = await journal.interrupt(
        {
          severity: "warning",
          code: "COMMAND_INTERRUPTED",
          message:
            "Apply was interrupted at a safe checkpoint. Inspect the journal before creating a fresh audit and plan.",
        },
        clock(),
      );
      return { plan, run, journalPath: journal.path };
    }
    throw error;
  } finally {
    await lock.release();
  }
}
