import { resolve } from "node:path";

import { loadConfigForHome } from "../config/load.js";
import { cleanupPlanSchema, type CleanupPlan } from "../contracts/plan.js";
import { auditReportSchema } from "../contracts/report.js";
import { createCleanupPlan } from "../core/plan.js";
import { readJsonFile, writeJsonAtomic } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";

export type PlanCommandOptions = {
  audit: string;
  config?: string;
  output?: string;
  stateDir?: string;
};

export type PlanCommandResult = {
  plan: CleanupPlan;
  statePath: string;
  output: string;
};

export async function executePlanCommand(options: PlanCommandOptions): Promise<PlanCommandResult> {
  const audit = auditReportSchema.parse(await readJsonFile(resolve(options.audit)));
  const { config } = await loadConfigForHome(audit.home, options.config);
  const plan = cleanupPlanSchema.parse(createCleanupPlan(audit, config));
  const layout = stateLayout(resolveStateRoot(audit.home, options.stateDir));
  const statePath = resolve(layout.plans, `${plan.planId}.json`);
  await writeJsonAtomic(statePath, plan, {
    privateDirectories: [layout.root, layout.plans],
  });

  if (options.output !== undefined) {
    await writeJsonAtomic(resolve(options.output), plan);
  }

  return {
    plan,
    statePath,
    output: `${JSON.stringify(plan, null, 2)}\n`,
  };
}
