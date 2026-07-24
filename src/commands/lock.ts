import { resolveStateRoot, stateLayout } from "../state/layout.js";
import {
  inspectApplyLock,
  recoverStaleApplyLock,
  type ApplyLockOwner,
  type ApplyLockStatus,
  type LockInspectionDependencies,
} from "../state/lock.js";

export type LockCommandOptions = {
  home: string;
  stateDir?: string | undefined;
  json: boolean;
  dependencies?: LockInspectionDependencies | undefined;
};

export type LockRecoverCommandOptions = LockCommandOptions & {
  yes: boolean;
};

export type LockStatusCommandResult = {
  status: ApplyLockStatus;
  output: string;
};

export type LockRecoverCommandResult = {
  owner: ApplyLockOwner;
  output: string;
};

function renderLockStatus(status: ApplyLockStatus): string {
  if (status.status === "absent") {
    return `apply lock: absent\npath: ${status.path}\n`;
  }
  if (status.status === "malformed") {
    return `apply lock: malformed\npath: ${status.path}\nreason: ${status.reason}\n`;
  }
  return [
    `apply lock: ${status.status}`,
    `path: ${status.path}`,
    `owner: ${status.owner.hostname} pid=${status.owner.pid}`,
    `command: ${status.owner.command}`,
    `plan: ${status.owner.planId}`,
    `run: ${status.owner.runId}`,
    `created: ${status.owner.createdAt}`,
    ...("reason" in status ? [`reason: ${status.reason}`] : []),
    "",
  ].join("\n");
}

export async function executeLockStatusCommand(
  options: LockCommandOptions,
): Promise<LockStatusCommandResult> {
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const status = await inspectApplyLock(layout.locks, options.dependencies);
  return {
    status,
    output: options.json ? `${JSON.stringify(status, null, 2)}\n` : renderLockStatus(status),
  };
}

export async function executeLockRecoverCommand(
  options: LockRecoverCommandOptions,
): Promise<LockRecoverCommandResult> {
  if (!options.yes) {
    throw new Error('lock recovery requires --yes after reviewing "agentrinse lock status"');
  }
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const owner = await recoverStaleApplyLock(layout.locks, options.dependencies);
  return {
    owner,
    output: options.json
      ? `${JSON.stringify({ status: "recovered", owner }, null, 2)}\n`
      : `recovered stale apply lock for run ${owner.runId}\n`,
  };
}
