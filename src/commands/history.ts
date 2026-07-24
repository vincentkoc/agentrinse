import { cleanupRunSchema, type CleanupRun } from "../contracts/run.js";
import { parseDurationMs } from "../core/duration.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";
import { listJsonRecords } from "../state/records.js";

export type HistoryCommandOptions = {
  home: string;
  stateDir?: string | undefined;
  since?: string | undefined;
  json: boolean;
  now?: Date | undefined;
};

export type HistoryCommandResult = {
  runs: CleanupRun[];
  output: string;
};

export function renderHistory(runs: CleanupRun[]): string {
  if (runs.length === 0) {
    return "No AgentRinse runs found.\n";
  }

  const lines = ["AgentRinse history", ""];
  for (const run of runs) {
    const applied = run.actions.filter((action) => action.status === "applied").length;
    const failed = run.actions.filter((action) =>
      ["failed", "rolled-back", "partially-applied"].includes(action.status),
    ).length;
    lines.push(
      `${run.startedAt}  ${run.status.padEnd(9)}  ${run.runId}  applied=${applied} failed=${failed}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function executeHistoryCommand(
  options: HistoryCommandOptions,
): Promise<HistoryCommandResult> {
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  let runs = await listJsonRecords(layout.runs, cleanupRunSchema);
  if (options.since !== undefined) {
    const cutoff = (options.now ?? new Date()).getTime() - parseDurationMs(options.since);
    runs = runs.filter((run) => Date.parse(run.startedAt) >= cutoff);
  }
  runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    runs,
    output: options.json ? `${JSON.stringify(runs, null, 2)}\n` : renderHistory(runs),
  };
}
