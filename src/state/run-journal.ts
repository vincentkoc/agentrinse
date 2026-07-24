import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { CleanupPlan } from "../contracts/plan.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import { cleanupRunSchema, type ActionExecution, type CleanupRun } from "../contracts/run.js";
import { writeJsonAtomic } from "./json-file.js";

export type RunJournal = {
  path: string;
  snapshot(): CleanupRun;
  updateAction(actionId: string, patch: Partial<ActionExecution>): Promise<CleanupRun>;
  complete(completedAt?: Date): Promise<CleanupRun>;
  interrupt(diagnostic: Diagnostic, completedAt?: Date): Promise<CleanupRun>;
};

export async function createRunJournal(
  runsDirectory: string,
  plan: CleanupPlan,
  startedAt = new Date(),
  runId: string = randomUUID(),
): Promise<RunJournal> {
  let run = cleanupRunSchema.parse({
    schemaVersion: 1,
    runId,
    planId: plan.planId,
    startedAt: startedAt.toISOString(),
    status: "running",
    actions: plan.actions.map((action) => ({
      actionId: action.actionId,
      type: action.type,
      status: "pending",
    })),
    reclaimedBytes: 0,
    diagnostics: [],
  });
  const path = join(runsDirectory, `${run.runId}.json`);
  const privateDirectories = [runsDirectory];
  await writeJsonAtomic(path, run, { privateDirectories });

  const persist = async (): Promise<CleanupRun> => {
    run = cleanupRunSchema.parse(run);
    await writeJsonAtomic(path, run, { privateDirectories });
    return structuredClone(run);
  };

  return {
    path,
    snapshot: () => structuredClone(run),
    async updateAction(actionId, patch) {
      const index = run.actions.findIndex((action) => action.actionId === actionId);
      if (index === -1) {
        throw new Error(`run journal does not contain action ${actionId}`);
      }

      run.actions[index] = {
        ...run.actions[index]!,
        ...patch,
        actionId,
      };
      run.reclaimedBytes = run.actions.reduce(
        (total, action) => total + (action.reclaimedBytes ?? 0),
        0,
      );
      return persist();
    },
    async complete(completedAt = new Date()) {
      const failed = run.actions.filter(
        (action) =>
          action.status === "failed" ||
          action.status === "rolled-back" ||
          action.status === "partially-applied",
      ).length;
      const applied = run.actions.filter((action) => action.status === "applied").length;
      run = {
        ...run,
        completedAt: completedAt.toISOString(),
        status: failed === 0 ? "completed" : applied > 0 ? "partial" : "failed",
      };
      return persist();
    },
    async interrupt(diagnostic, completedAt = new Date()) {
      run = {
        ...run,
        completedAt: completedAt.toISOString(),
        status: "interrupted",
        diagnostics: [...run.diagnostics, diagnostic],
      };
      return persist();
    },
  };
}
