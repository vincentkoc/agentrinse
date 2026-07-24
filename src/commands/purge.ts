import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { loadConfigForHome } from "../config/load.js";
import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import { purgeWorktreeQuarantine, type PurgeWorktreeOptions } from "../core/worktree-recovery.js";
import { ensurePrivateDirectory } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";
import { acquireApplyLock } from "../state/lock.js";
import { listJsonRecords } from "../state/records.js";
import { confirmMutation, type ConfirmationDependencies } from "./confirmation.js";

export type PurgeCommandOptions = {
  home: string;
  config?: string;
  stateDir?: string;
  expired: boolean;
  runId?: string;
  apply: boolean;
  yes: boolean;
  json: boolean;
  now?: Date;
  dependencies?: ConfirmationDependencies & {
    purge?: (
      entry: QuarantineEntry,
      options: PurgeWorktreeOptions,
    ) => Promise<{ entry: QuarantineEntry; reclaimedBytes: number }>;
  };
};

export type PurgeCommandResult = {
  entries: QuarantineEntry[];
  applied: boolean;
  reclaimedBytes: number;
  output: string;
};

function renderPreview(entries: QuarantineEntry[], now: Date): string {
  if (entries.length === 0) {
    return "No matching quarantine entries.\n";
  }
  const lines = ["AgentRinse quarantine purge preview", ""];
  for (const entry of entries) {
    lines.push(
      `${entry.entryId}  run=${entry.runId}  bytes=${entry.target.measuredBytes}  ${
        Date.parse(entry.expiresAt) <= now.getTime() ? "expired" : `expires=${entry.expiresAt}`
      }`,
    );
  }
  lines.push("", "Preview only. Add --apply and --yes to purge.");
  return `${lines.join("\n")}\n`;
}

export async function executePurgeCommand(
  options: PurgeCommandOptions,
): Promise<PurgeCommandResult> {
  if (options.expired && options.runId !== undefined) {
    throw new Error("purge accepts only one of --expired or --run");
  }
  if (options.apply && !options.expired && options.runId === undefined) {
    throw new Error("purge --apply requires --expired or --run");
  }
  if (options.json && options.apply && !options.yes) {
    throw new Error("purge --json --apply requires --yes");
  }
  const now = options.now ?? new Date();
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const live = (await listJsonRecords(layout.quarantine, quarantineEntrySchema)).filter(
    (entry) => entry.status === "quarantined",
  );
  const entries = live.filter((entry) =>
    options.expired
      ? Date.parse(entry.expiresAt) <= now.getTime()
      : options.runId === undefined || entry.runId === options.runId,
  );

  if (!options.apply) {
    return {
      entries,
      applied: false,
      reclaimedBytes: 0,
      output: options.json
        ? `${JSON.stringify({ applied: false, entries }, null, 2)}\n`
        : renderPreview(entries, now),
    };
  }
  if (entries.length === 0) {
    throw new Error("no matching live quarantine entries to purge");
  }
  if (
    !options.yes &&
    !(await confirmMutation(
      `Permanently purge ${entries.length} quarantined worktree(s)? [y/N] `,
      options.dependencies,
    ))
  ) {
    throw new Error("purge cancelled");
  }

  const { config } = await loadConfigForHome(options.home, options.config);
  await ensurePrivateDirectory(layout.locks);
  const operationId = randomUUID();
  const lock = await acquireApplyLock(layout.locks, {
    planId: `purge:${options.runId ?? "expired"}`,
    runId: operationId,
    command: "agentrinse purge",
  });
  const purged: QuarantineEntry[] = [];
  let reclaimedBytes = 0;
  try {
    for (const entry of entries) {
      const result = await (options.dependencies?.purge ?? purgeWorktreeQuarantine)(entry, {
        manifestPath: join(layout.quarantine, `${entry.entryId}.json`),
        quarantineDirectory: layout.quarantine,
        maxEntries: config.audit.maxEntries,
        allowUnexpired: options.runId !== undefined,
      });
      purged.push(result.entry);
      reclaimedBytes += result.reclaimedBytes;
    }
  } finally {
    await lock.release();
  }

  return {
    entries: purged,
    applied: true,
    reclaimedBytes,
    output: options.json
      ? `${JSON.stringify({ applied: true, reclaimedBytes, entries: purged }, null, 2)}\n`
      : `purged ${purged.length} quarantined worktree(s); reclaimed ${reclaimedBytes} bytes\n`,
  };
}
