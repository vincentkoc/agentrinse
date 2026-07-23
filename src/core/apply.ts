import type { AgentRinseConfig } from "../config/schema.js";
import type { ArtifactRemoveAction } from "../contracts/action.js";
import type { CleanupPlan } from "../contracts/plan.js";
import type { CleanupRun } from "../contracts/run.js";
import { acquireApplyLock } from "../state/lock.js";
import { stateLayout } from "../state/layout.js";
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
import { verifyCleanupPlan } from "./plan-verification.js";
import { isPathInside } from "./safety.js";

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
  revalidate?: (
    action: ArtifactRemoveAction,
    home: string,
    config: AgentRinseConfig,
  ) => Promise<ArtifactRevalidationResult>;
  execute?: (action: ArtifactRemoveAction, isolationId: string) => Promise<ArtifactExecutionResult>;
};

export type ApplyCleanupPlanOptions = {
  input: unknown;
  config: AgentRinseConfig;
  stateRoot: string;
  dependencies?: ApplyDependencies;
};

export async function applyCleanupPlan(options: ApplyCleanupPlanOptions): Promise<ApplyResult> {
  const clock = options.dependencies?.clock ?? (() => new Date());
  const plan = verifyCleanupPlan(options.input, options.config, clock());
  const layout = stateLayout(options.stateRoot);
  for (const action of plan.actions) {
    if (isPathInside(action.target.path, layout.root)) {
      throw new ApplySafetyError(
        `state directory ${layout.root} must not be inside cleanup target ${action.target.path}`,
      );
    }
  }
  const lock = await acquireApplyLock(layout.locks, plan.planId);

  try {
    const journal = await createRunJournal(layout.runs, plan, clock());
    const runId = journal.snapshot().runId;

    for (const action of plan.actions) {
      const startedAt = clock().toISOString();
      await journal.updateAction(action.actionId, {
        status: "revalidating",
        startedAt,
      });

      const revalidation = await (options.dependencies?.revalidate ?? revalidateArtifactRemove)(
        action,
        plan.home,
        options.config,
      );
      if (revalidation.status === "stale") {
        await journal.updateAction(action.actionId, {
          status: "skipped-stale",
          completedAt: clock().toISOString(),
          diagnostic: revalidation.diagnostic,
        });
        continue;
      }

      const isolationId = `${runId}-${sha256(action.actionId).slice(0, 12)}`;
      const isolationPath = artifactIsolationPath(action, isolationId);
      await journal.updateAction(action.actionId, {
        status: "applying",
        isolationPath,
      });

      try {
        const result = await (
          options.dependencies?.execute ??
          ((selectedAction, selectedIsolationId) =>
            executeArtifactRemove(selectedAction, {
              id: () => selectedIsolationId,
            }))
        )(action, isolationId);
        await journal.updateAction(action.actionId, {
          status: "applied",
          completedAt: clock().toISOString(),
          reclaimedBytes: result.reclaimedBytes,
          isolationPath: result.isolationPath,
        });
      } catch (error) {
        const executionError = error instanceof ArtifactExecutionError ? error : undefined;
        await journal.updateAction(action.actionId, {
          status: executionError?.outcome ?? "failed",
          completedAt: clock().toISOString(),
          isolationPath: executionError?.isolationPath ?? isolationPath,
          diagnostic: {
            severity: "error",
            code:
              executionError?.outcome === "partially-applied"
                ? "ARTIFACT_PARTIALLY_APPLIED"
                : executionError?.outcome === "rolled-back"
                  ? "ARTIFACT_ROLLED_BACK"
                  : "ARTIFACT_APPLY_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: action.adapter,
            resourceId: action.resourceId,
          },
        });
        break;
      }
    }

    const run = await journal.complete(clock());
    return { plan, run, journalPath: journal.path };
  } finally {
    await lock.release();
  }
}
