import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import { auditReportSchema, type AuditReport } from "../contracts/report.js";
import { cleanupRunSchema, type CleanupRun } from "../contracts/run.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";
import { listJsonRecords, readJsonRecord } from "../state/records.js";

export type ShowCommandOptions = {
  home: string;
  stateDir?: string | undefined;
  json: boolean;
};

export type ShowCommandResult<T> = {
  value: T;
  output: string;
};

export function renderRunDetails(run: CleanupRun): string {
  const lines = [`run ${run.runId}: ${run.status}`, `plan ${run.planId}`, ""];
  for (const action of run.actions) {
    lines.push(`${action.status.padEnd(18)} ${action.actionId} ${action.type}`);
    if (action.diagnostic !== undefined) {
      lines.push(`  ${action.diagnostic.code}: ${action.diagnostic.message}`);
    }
    if (action.type === "artifacts.remove" && action.isolationPath !== undefined) {
      lines.push(`  isolation: ${action.isolationPath}`);
    }
    if (action.type === "worktree.quarantine" && action.quarantinePath !== undefined) {
      lines.push(`  quarantine: ${action.quarantinePath}`);
    }
  }

  if (run.status === "partial" || run.status === "failed" || run.status === "interrupted") {
    lines.push(
      "",
      "Recovery: inspect every isolation path and diagnostic above.",
      "Do not retry the old plan; resolve partial state, then create a fresh audit and plan.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function executeShowRunCommand(
  idOrPath: string,
  options: ShowCommandOptions,
): Promise<ShowCommandResult<CleanupRun>> {
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const run = await readJsonRecord(layout.runs, idOrPath, cleanupRunSchema);
  return {
    value: run,
    output: options.json ? `${JSON.stringify(run, null, 2)}\n` : renderRunDetails(run),
  };
}

export async function executeShowPlanCommand(
  idOrPath: string,
  options: ShowCommandOptions,
): Promise<ShowCommandResult<CleanupPlan>> {
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const plan = await readJsonRecord(layout.plans, idOrPath, cleanupPlanSchema);
  return {
    value: plan,
    output: `${JSON.stringify(plan, null, 2)}\n`,
  };
}

export async function executeShowResourceCommand(
  resourceId: string,
  options: ShowCommandOptions,
): Promise<ShowCommandResult<{ audit: AuditReport; finding: AuditReport["findings"][number] }>> {
  const layout = stateLayout(resolveStateRoot(options.home, options.stateDir));
  const audits = await listJsonRecords(layout.audits, auditReportSchema);
  audits.sort((left, right) => right.completedAt.localeCompare(left.completedAt));

  for (const audit of audits) {
    const finding = audit.findings.find((candidate) => candidate.resource.id === resourceId);
    if (finding !== undefined) {
      const value = { audit, finding };
      return {
        value,
        output: `${JSON.stringify(value, null, 2)}\n`,
      };
    }
  }
  throw new Error(`resource ${resourceId} was not found in persisted audits`);
}
