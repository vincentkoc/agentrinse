import { resolve } from "node:path";

import { loadConfig } from "../config/load.js";
import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import { auditReportSchema } from "../contracts/report.js";
import { createCleanupPlan } from "../core/plan.js";
import { readJsonFile, writeJsonAtomic } from "../state/json-file.js";

export type PlanCommandOptions = {
  audit: string;
  config?: string;
  output?: string;
};

export type PlanCommandResult = {
  plan: CleanupPlan;
  output: string;
};

export async function executePlanCommand(
  options: PlanCommandOptions,
): Promise<PlanCommandResult> {
  const audit = auditReportSchema.parse(
    await readJsonFile(resolve(options.audit)),
  );
  const config = await loadConfig(options.config);
  const plan = cleanupPlanSchema.parse(createCleanupPlan(audit, config));

  if (options.output !== undefined) {
    await writeJsonAtomic(resolve(options.output), plan);
  }

  return {
    plan,
    output: `${JSON.stringify(plan, null, 2)}\n`,
  };
}

