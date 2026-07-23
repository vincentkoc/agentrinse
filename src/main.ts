import { Command } from "commander";

import { executeAuditCommand } from "./commands/audit.js";
import { renderAdapters } from "./commands/adapters.js";
import { executeApplyCommand } from "./commands/apply.js";
import { executePlanCommand } from "./commands/plan.js";

export function buildProgram(): Command {
  const program = new Command()
    .name("agentrinse")
    .description("Safe cleanup for agentic development.")
    .version("0.0.0");

  program
    .command("audit")
    .description("Inventory a home without mutating it.")
    .requiredOption("--home <path>", "home directory to audit")
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
    .command("apply")
    .description("Apply an authorized cleanup plan after revalidation.")
    .requiredOption("--plan <path>", "saved cleanup plan JSON")
    .option("--config <path>", "same explicit JSON config used to create the plan")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--yes", "authorize non-interactive apply", false)
    .option("--json", "emit the versioned run journal", false)
    .action(
      async (options: {
        plan: string;
        config?: string;
        stateDir?: string;
        yes: boolean;
        json: boolean;
      }) => {
        const result = await executeApplyCommand(options);
        process.stdout.write(result.output);
        if (["failed", "partial"].includes(result.run.status)) {
          process.exitCode = 2;
        }
      },
    );

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
