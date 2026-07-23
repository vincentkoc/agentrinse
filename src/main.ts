import { Command } from "commander";

import { executeAuditCommand } from "./commands/audit.js";
import { renderAdapters } from "./commands/adapters.js";
import { executePlanCommand } from "./commands/plan.js";

export function buildProgram(): Command {
  const program = new Command()
    .name("agentrinse")
    .description("Safe cleanup planning for agentic development.")
    .version("0.0.0");

  program
    .command("audit")
    .description("Inventory a synthetic home without mutating it.")
    .requiredOption("--home <path>", "synthetic home to audit; the real home is refused")
    .option("--config <path>", "explicit JSON config")
    .option("--json", "emit the versioned JSON report", false)
    .option("--output <path>", "write the JSON report atomically")
    .action(async (options: { home: string; config?: string; json: boolean; output?: string }) => {
      const result = await executeAuditCommand(options);
      process.stdout.write(result.output);
    });

  program
    .command("plan")
    .description("Create a dry-run cleanup plan from a saved audit.")
    .requiredOption("--audit <path>", "saved audit JSON")
    .option("--config <path>", "explicit JSON config")
    .option("--output <path>", "write the plan atomically")
    .action(async (options: { audit: string; config?: string; output?: string }) => {
      const result = await executePlanCommand(options);
      process.stdout.write(result.output);
    });

  program
    .command("adapters")
    .description("List adapter maturity and ownership.")
    .action(() => {
      process.stdout.write(renderAdapters());
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}
