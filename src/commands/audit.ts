import { resolve } from "node:path";

import { createAuditAdapters } from "../adapters/registry.js";
import { loadConfigForHome } from "../config/load.js";
import type { AuditReport } from "../contracts/report.js";
import { runAudit } from "../core/audit.js";
import { renderAudit } from "../output.js";
import { writeJsonAtomic } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";

export type AuditCommandOptions = {
  home: string;
  config?: string;
  json: boolean;
  output?: string;
  stateDir?: string;
};

export type AuditCommandResult = {
  report: AuditReport;
  statePath: string;
  output: string;
};

export async function executeAuditCommand(
  options: AuditCommandOptions,
): Promise<AuditCommandResult> {
  const home = resolve(options.home);
  const { config } = await loadConfigForHome(home, options.config);
  const report = await runAudit({
    home,
    config,
    adapters: createAuditAdapters(config),
  });
  const statePath = resolve(
    stateLayout(resolveStateRoot(home, options.stateDir)).audits,
    `${report.auditId}.json`,
  );
  await writeJsonAtomic(statePath, report);

  if (options.output !== undefined) {
    await writeJsonAtomic(resolve(options.output), report);
  }

  return {
    report,
    statePath,
    output: options.json ? `${JSON.stringify(report, null, 2)}\n` : renderAudit(report),
  };
}
