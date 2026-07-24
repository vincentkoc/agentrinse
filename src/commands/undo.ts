import { randomUUID } from "node:crypto";

import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { undoWorktreeQuarantine, type WorktreeRecoveryOptions } from "../core/worktree-recovery.js";
import { ensurePrivateDirectory } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";
import { acquireApplyLock } from "../state/lock.js";
import { listJsonRecordFiles } from "../state/records.js";
import { confirmMutation, type ConfirmationDependencies } from "./confirmation.js";

export type UndoCommandOptions = {
  runId: string;
  actionId?: string;
  home: string;
  config?: string;
  stateDir?: string;
  yes: boolean;
  json: boolean;
  dependencies?: ConfirmationDependencies & {
    undo?: (entry: QuarantineEntry, options: WorktreeRecoveryOptions) => Promise<QuarantineEntry>;
  };
};

export type UndoCommandResult = {
  entries: QuarantineEntry[];
  output: string;
};

export async function executeUndoCommand(options: UndoCommandOptions): Promise<UndoCommandResult> {
  if (options.json && !options.yes) {
    throw new Error("undo --json requires --yes");
  }
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const records = await listJsonRecordFiles(layout.quarantine, quarantineEntrySchema);
  for (const record of records) {
    if (record.name !== `${record.value.entryId}.json`) {
      throw new Error(`quarantine manifest entry ID does not match filename: ${record.name}`);
    }
  }
  const entries = records.filter(
    ({ value }) =>
      ["quarantined", "restoring"].includes(value.status) &&
      value.runId === options.runId &&
      (options.actionId === undefined || value.actionId === options.actionId),
  );
  if (entries.length === 0) {
    throw new Error(`no live quarantine entries found for run ${options.runId}`);
  }
  if (
    !options.yes &&
    !(await confirmMutation(
      `Restore ${entries.length} quarantined worktree(s) from run ${options.runId}? [y/N] `,
      options.dependencies,
    ))
  ) {
    throw new Error("undo cancelled");
  }

  await ensurePrivateDirectory(layout.locks);
  const operationId = randomUUID();
  const lock = await acquireApplyLock(layout.locks, {
    planId: `undo:${options.runId}`,
    runId: operationId,
    command: "agentrinse undo",
  });
  const restored: QuarantineEntry[] = [];
  try {
    for (const record of entries) {
      const entry = record.value;
      restored.push(
        await (options.dependencies?.undo ?? undoWorktreeQuarantine)(entry, {
          manifestPath: record.path,
          quarantineDirectory: layout.quarantine,
        }),
      );
    }
  } finally {
    await lock.release();
  }

  return {
    entries: restored,
    output: options.json
      ? `${JSON.stringify(restored, null, 2)}\n`
      : `restored ${restored.length} quarantined worktree(s) from run ${options.runId}\n`,
  };
}
