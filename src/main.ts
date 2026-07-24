import { Command } from "commander";
import { homedir } from "node:os";

import { executeAuditCommand } from "./commands/audit.js";
import { renderAdapters } from "./commands/adapters.js";
import { executeApplyCommand } from "./commands/apply.js";
import {
  executeConfigInitCommand,
  executeConfigPathCommand,
  executeConfigShowCommand,
  executeConfigValidateCommand,
} from "./commands/config.js";
import { executeDoctorCommand } from "./commands/doctor.js";
import { executeHistoryCommand } from "./commands/history.js";
import { executeLockRecoverCommand, executeLockStatusCommand } from "./commands/lock.js";
import { executePlanCommand } from "./commands/plan.js";
import {
  executeShowPlanCommand,
  executeShowResourceCommand,
  executeShowRunCommand,
} from "./commands/show.js";
import { VERSION } from "./version.js";

export function buildProgram(): Command {
  const program = new Command()
    .name("agentrinse")
    .description("Safe cleanup for agentic development.")
    .version(VERSION);

  program
    .command("audit")
    .description("Inventory a home without mutating it.")
    .option("--home <path>", "home directory to audit")
    .option("--config <path>", "explicit JSON config")
    .option("--json", "emit the versioned JSON report", false)
    .option("--ndjson", "stream versioned NDJSON events", false)
    .option("--redact", "redact paths and identifiers in machine output", false)
    .option("--output <path>", "write the JSON report atomically")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .action(
      async (options: {
        home?: string;
        config?: string;
        json: boolean;
        ndjson: boolean;
        redact: boolean;
        output?: string;
        stateDir?: string;
      }) => {
        const result = await executeAuditCommand({
          ...options,
          home: options.home ?? homedir(),
          ...(options.ndjson ? { emit: (output) => process.stdout.write(output) } : {}),
        });
        if (result.output !== "") {
          process.stdout.write(result.output);
        }
      },
    );

  program
    .command("plan")
    .description("Create a dry-run cleanup plan from a saved audit.")
    .requiredOption("--audit <path>", "saved audit JSON")
    .option("--config <path>", "explicit JSON config")
    .option("--output <path>", "write the plan atomically")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .action(
      async (options: { audit: string; config?: string; output?: string; stateDir?: string }) => {
        const result = await executePlanCommand(options);
        process.stdout.write(result.output);
      },
    );

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

  program
    .command("doctor")
    .description("Diagnose platform, configuration, state, and optional integrations.")
    .option("--home <path>", "home directory used for diagnostics")
    .option("--config <path>", "explicit JSON config")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--json", "emit the versioned JSON report", false)
    .action(
      async (options: { home?: string; config?: string; stateDir?: string; json: boolean }) => {
        const result = await executeDoctorCommand({
          ...options,
          home: options.home ?? homedir(),
        });
        process.stdout.write(result.output);
        if (result.report.status === "error") {
          process.exitCode = 1;
        }
      },
    );

  const config = program.command("config").description("Inspect and initialize configuration.");

  config
    .command("path")
    .description("Print the resolved configuration path.")
    .option("--home <path>", "home directory used for default resolution")
    .option("--config <path>", "explicit JSON config")
    .action((options: { home?: string; config?: string }) => {
      process.stdout.write(
        executeConfigPathCommand({
          home: options.home ?? homedir(),
          config: options.config,
        }).output,
      );
    });

  config
    .command("init")
    .description("Create a default configuration without overwriting.")
    .option("--home <path>", "home directory used for default resolution")
    .option("--config <path>", "explicit JSON config")
    .action(async (options: { home?: string; config?: string }) => {
      const result = await executeConfigInitCommand({
        home: options.home ?? homedir(),
        config: options.config,
      });
      process.stdout.write(result.output);
    });

  config
    .command("show")
    .description("Print the effective configuration.")
    .option("--home <path>", "home directory used for default resolution")
    .option("--config <path>", "explicit JSON config")
    .action(async (options: { home?: string; config?: string }) => {
      const result = await executeConfigShowCommand({
        home: options.home ?? homedir(),
        config: options.config,
      });
      process.stdout.write(result.output);
    });

  config
    .command("validate")
    .description("Validate an existing configuration file.")
    .option("--home <path>", "home directory used for default resolution")
    .option("--config <path>", "explicit JSON config")
    .action(async (options: { home?: string; config?: string }) => {
      const result = await executeConfigValidateCommand({
        home: options.home ?? homedir(),
        config: options.config,
      });
      process.stdout.write(result.output);
    });

  program
    .command("history")
    .description("List persisted cleanup runs.")
    .option("--home <path>", "home directory used for state resolution")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--since <duration>", "include runs newer than a duration such as 30d")
    .option("--json", "emit JSON", false)
    .action(
      async (options: { home?: string; stateDir?: string; since?: string; json: boolean }) => {
        const result = await executeHistoryCommand({
          ...options,
          home: options.home ?? homedir(),
        });
        process.stdout.write(result.output);
      },
    );

  const show = program.command("show").description("Inspect persisted AgentRinse records.");

  show
    .command("run <run-id-or-path>")
    .description("Show one cleanup run.")
    .option("--home <path>", "home directory used for state resolution")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--json", "emit JSON", false)
    .action(
      async (idOrPath: string, options: { home?: string; stateDir?: string; json: boolean }) => {
        const result = await executeShowRunCommand(idOrPath, {
          ...options,
          home: options.home ?? homedir(),
        });
        process.stdout.write(result.output);
      },
    );

  show
    .command("plan <plan-id-or-path>")
    .description("Show one cleanup plan.")
    .option("--home <path>", "home directory used for state resolution")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--json", "emit JSON", false)
    .action(
      async (idOrPath: string, options: { home?: string; stateDir?: string; json: boolean }) => {
        const result = await executeShowPlanCommand(idOrPath, {
          ...options,
          home: options.home ?? homedir(),
        });
        process.stdout.write(result.output);
      },
    );

  show
    .command("resource <resource-id>")
    .description("Show the latest persisted resource finding.")
    .option("--home <path>", "home directory used for state resolution")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--json", "emit JSON", false)
    .action(
      async (resourceId: string, options: { home?: string; stateDir?: string; json: boolean }) => {
        const result = await executeShowResourceCommand(resourceId, {
          ...options,
          home: options.home ?? homedir(),
        });
        process.stdout.write(result.output);
      },
    );

  const lock = program.command("lock").description("Inspect and recover the apply lock.");

  lock
    .command("status")
    .description("Inspect the apply lock and its recorded process identity.")
    .option("--home <path>", "home directory used for state resolution")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--json", "emit JSON", false)
    .action(async (options: { home?: string; stateDir?: string; json: boolean }) => {
      const result = await executeLockStatusCommand({
        ...options,
        home: options.home ?? homedir(),
      });
      process.stdout.write(result.output);
    });

  lock
    .command("recover")
    .description("Remove a local lock only after proving its process identity is gone.")
    .option("--home <path>", "home directory used for state resolution")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--yes", "authorize recovery after inspecting the lock", false)
    .option("--json", "emit JSON", false)
    .action(async (options: { home?: string; stateDir?: string; yes: boolean; json: boolean }) => {
      const result = await executeLockRecoverCommand({
        ...options,
        home: options.home ?? homedir(),
      });
      process.stdout.write(result.output);
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}
