import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { loadConfigForHome } from "../config/load.js";
import { cleanupPlanSchema } from "../contracts/plan.js";
import type { CleanupRun } from "../contracts/run.js";
import { applyCleanupPlan } from "../core/apply.js";
import { readJsonFile } from "../state/json-file.js";
import { resolveStateRoot } from "../state/layout.js";
import { VERSION } from "../version.js";

export type ApplyCommandOptions = {
  plan: string;
  config?: string;
  stateDir?: string;
  yes: boolean;
  json: boolean;
  signal?: AbortSignal;
};

export type ApplyCommandResult = {
  run: CleanupRun;
  journalPath: string;
  output: string;
};

async function confirmApply(actionCount: number): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("apply requires --yes when stdin or stdout is not an interactive terminal");
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(`Apply ${actionCount} safe cleanup action(s)? [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

function renderRun(run: CleanupRun, journalPath: string): string {
  const applied = run.actions.filter((action) => action.status === "applied").length;
  const skipped = run.actions.filter((action) => action.status === "skipped-stale").length;
  const failed = run.actions.length - applied - skipped;
  return [
    `run ${run.runId}: ${run.status}`,
    `applied ${applied}, skipped ${skipped}, failed ${failed}`,
    `reclaimed ${run.reclaimedBytes} bytes`,
    `journal ${journalPath}`,
    "",
  ].join("\n");
}

export async function executeApplyCommand(
  options: ApplyCommandOptions,
): Promise<ApplyCommandResult> {
  if (options.json && !options.yes) {
    throw new Error("apply --json requires --yes");
  }
  if (VERSION === "0.0.0") {
    throw new Error("apply is unavailable in the unsupported 0.0.0 reservation release");
  }

  const input = await readJsonFile(resolve(options.plan));
  const plan = cleanupPlanSchema.parse(input);
  const { config } = await loadConfigForHome(plan.home, options.config);

  if (!options.yes && !(await confirmApply(plan.actions.length))) {
    throw new Error("apply cancelled");
  }

  const result = await applyCleanupPlan({
    input,
    config,
    stateRoot: resolveStateRoot(plan.home, options.stateDir),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    run: result.run,
    journalPath: result.journalPath,
    output: options.json
      ? `${JSON.stringify(result.run, null, 2)}\n`
      : renderRun(result.run, result.journalPath),
  };
}
