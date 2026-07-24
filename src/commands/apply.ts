import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";

import { loadConfigForHome } from "../config/load.js";
import { cleanupPlanSchema } from "../contracts/plan.js";
import type { CleanupRun } from "../contracts/run.js";
import { applyCleanupPlan } from "../core/apply.js";
import { CommandInterruptedError } from "../core/interruption.js";
import { readJsonFile } from "../state/json-file.js";
import { resolveStateRoot } from "../state/layout.js";

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

export type ConfirmApplyDependencies = {
  isInteractive?: () => boolean;
  question?: (prompt: string, signal?: AbortSignal) => Promise<string>;
};

async function defaultQuestion(promptText: string, signal?: AbortSignal): Promise<string> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return signal === undefined
      ? await prompt.question(promptText)
      : await prompt.question(promptText, { signal });
  } finally {
    prompt.close();
  }
}

function interruptionFrom(signal?: AbortSignal): CommandInterruptedError | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }
  return signal.reason instanceof CommandInterruptedError
    ? signal.reason
    : new CommandInterruptedError("apply interrupted");
}

export async function confirmApply(
  actionCount: number,
  signal?: AbortSignal,
  dependencies: ConfirmApplyDependencies = {},
): Promise<boolean> {
  const initialInterruption = interruptionFrom(signal);
  if (initialInterruption !== undefined) {
    throw initialInterruption;
  }
  if (!(dependencies.isInteractive ?? (() => process.stdin.isTTY && process.stdout.isTTY))()) {
    throw new Error("apply requires --yes when stdin or stdout is not an interactive terminal");
  }

  try {
    const answer = await (dependencies.question ?? defaultQuestion)(
      `Apply ${actionCount} safe cleanup action(s)? [y/N] `,
      signal,
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } catch (error) {
    const interruption = interruptionFrom(signal);
    if (interruption !== undefined) {
      throw interruption;
    }
    throw error;
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
  const input = await readJsonFile(resolve(options.plan));
  const plan = cleanupPlanSchema.parse(input);
  const { config } = await loadConfigForHome(plan.home, options.config);

  if (!options.yes && !(await confirmApply(plan.actions.length, options.signal))) {
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
