import { Command } from "commander";
import { homedir } from "node:os";

import { executeAuditCommand } from "./commands/audit.js";
import { renderAdapters } from "./commands/adapters.js";
import { executeApplyCommand } from "./commands/apply.js";
import { cleanCommandExitCode, executeCleanCommand } from "./commands/clean.js";
import {
  executeConfigInitCommand,
  executeConfigPathCommand,
  executeConfigShowCommand,
  executeConfigRenderCommand,
  executeConfigPolicyCommand,
  executeConfigValidateCommand,
} from "./commands/config.js";
import { renderCompletion } from "./commands/completion.js";
import { executeDoctorCommand } from "./commands/doctor.js";
import { executeHistoryCommand } from "./commands/history.js";
import { executeLockRecoverCommand, executeLockStatusCommand } from "./commands/lock.js";
import { executePrGcDiff } from "./commands/openclaw-pr-gc-diff.js";
import { executePlanCommand } from "./commands/plan.js";
import { executePurgeCommand } from "./commands/purge.js";
import {
  executeShowPlanCommand,
  executeShowResourceCommand,
  executeShowRunCommand,
} from "./commands/show.js";
import { executeStorageRulesCommand } from "./commands/storage-rules.js";
import { executeStorageCommand } from "./commands/storage.js";
import { executeGitInventory } from "./commands/git-inventory.js";
import { executeWorktreeGrades } from "./commands/worktree-grades.js";
import { executeWorktreesCommand } from "./commands/worktrees.js";
import { executeUndoCommand } from "./commands/undo.js";
import { CommandInterruptedError } from "./core/interruption.js";
import { VERSION } from "./version.js";

export function buildProgram(): Command {
  const collectOption = (value: string, previous: string[]): string[] => [...previous, value];
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
    .option("--providers <ids>", "audit only comma-separated provider IDs; requires --no-state")
    .option("--quick", "run bounded provider inventory without size measurement", false)
    .option(
      "--phase-timeout <duration>",
      "cooperative quick inventory cutoff for each provider phase",
    )
    .option("--no-state", "do not persist audit state; requires JSON or NDJSON")
    .option("--output <path>", "write the JSON report atomically")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option(
      "--allow-offline-vacuum",
      "propose experimental offline Codex database compaction",
      false,
    )
    .action(
      async (options: {
        home?: string;
        config?: string;
        json: boolean;
        ndjson: boolean;
        redact: boolean;
        providers?: string;
        quick: boolean;
        phaseTimeout?: string;
        state: boolean;
        output?: string;
        stateDir?: string;
        allowOfflineVacuum: boolean;
      }) => {
        const controller = new AbortController();
        const interrupt = () => {
          controller.abort(new CommandInterruptedError("interrupted by SIGINT"));
        };
        process.on("SIGINT", interrupt);
        try {
          const result = await executeAuditCommand({
            ...options,
            home: options.home ?? homedir(),
            noState: options.state === false,
            signal: controller.signal,
            ...(options.ndjson ? { emit: (output) => process.stdout.write(output) } : {}),
          });
          if (result.output !== "") {
            process.stdout.write(result.output);
          }
        } finally {
          process.removeListener("SIGINT", interrupt);
        }
      },
    );

  program
    .command("storage-rules")
    .description("List storage locations, metadata scopes, and evidence supplied by native owners.")
    .option("--json", "emit versioned machine output", false)
    .action((options) => {
      process.stdout.write(executeStorageRulesCommand(options.json));
    });

  program
    .command("storage")
    .option("--config <path>", "use saved storage selection defaults")
    .option("--home <path>", "home directory for inventory and config resolution")
    .description(
      "Inventory explicit hidden storage and native mount metadata without creating a plan.",
    )
    .option(
      "--family <name>",
      "select developer, retained, vm, mounts, openclaw, crabbox or git; repeatable",
      collectOption,
      [],
    )
    .option(
      "--repo <path>",
      "inspect pack metadata in a durable Git owner; repeatable",
      collectOption,
      [],
    )
    .option(
      "--crabbox-root <path>",
      "use an explicit source staging container; repeatable",
      collectOption,
      [],
    )
    .option(
      "--retained-root <path>",
      "observe one explicit protected location without listing it; repeatable",
      collectOption,
      [],
    )
    .option(
      "--volume <path>",
      "identify the covering kernel mount without probing the path; repeatable",
      collectOption,
      [],
    )
    .option(
      "--measure",
      "measure eligible catalog cache trees or explicitly selected OpenClaw lane caches",
      false,
    )
    .option(
      "--project <path>",
      "inspect retained project locations such as vendor without enumerating content; repeatable",
      collectOption,
      [],
    )
    .option(
      "--native-volume <mountpoint>",
      "inspect snapshots or allocator usage on an already mounted APFS or Btrfs volume",
      collectOption,
      [],
    )
    .option("--system", "include known system-owned storage locations on this platform", false)
    .option(
      "--at <rule=path>",
      "inspect a supplied rule at an absolute protected location; repeatable",
      collectOption,
      [],
    )
    .option("--rule <id>", "select a catalog location by rule ID; repeatable", collectOption, [])
    .option("--max-entries <count>", "maximum enumerated entries across storage roots", "20000")
    .option("--redact", "redact paths in output", false)
    .option("--json", "emit versioned machine output", false)
    .action(async (options) => {
      process.stdout.write(
        await executeStorageCommand({ ...options, home: options.home ?? homedir() }),
      );
    });

  program
    .command("git-inventory")
    .description(
      "Account for Git pack storage and linked registrations without creating a cleanup plan.",
    )
    .option(
      "--repo-root <path>",
      "inspect direct children of a repository parent; repeatable",
      collectOption,
      [],
    )
    .option(
      "--repo <path>",
      "inspect one durable worktree owner or bare repository; repeatable",
      collectOption,
      [],
    )
    .option(
      "--worktree-root <path>",
      "classify registrations under an additional managed container; repeatable",
      collectOption,
      [],
    )
    .option(
      "--loose-objects",
      "count canonical loose object names in direct hex fanouts using the shared budget",
      false,
    )
    .option(
      "--pack-headers",
      "inspect bounded header-only temporary packs without reading object bodies",
      false,
    )
    .option("--gwt-status-stdin", "read native lifecycle evidence from stdin", false)
    .option("--max-entries <count>", "shared direct storage entry budget", "1000000")
    .option("--redact", "redact paths and identifiers", false)
    .option("--json", "emit versioned machine output", false)
    .action(async (options) => {
      process.stdout.write(await executeGitInventory({ ...options, home: homedir() }));
    });

  program
    .command("worktree-grades")
    .description(
      "Grade selected registered linked worktrees without saving an audit or planning actions.",
    )
    .requiredOption("--repo <path>", "one literal absolute durable owner", collectOption, [])
    .requiredOption(
      "--worktree <path>",
      "literal absolute linked checkout; repeat up to 64 times",
      collectOption,
      [],
    )
    .option("--config <path>", "explicit JSON config")
    .option("--home <path>", "home directory for provider ownership discovery")
    .option("--redact", "omit paths and resource identifiers", false)
    .option("--json", "emit versioned machine output", false)
    .action(async (options) => {
      process.stdout.write(
        await executeWorktreeGrades({
          ...options,
          repo: options.repo,
          worktree: options.worktree,
          home: options.home ?? homedir(),
        }),
      );
    });

  program
    .command("openclaw-pr-gc-diff")
    .description("Compare a frozen OpenClaw PR GC preview with a native apply log.")
    .requiredOption("--repo <path>", "canonical owner recorded with the logs")
    .requiredOption("--preview <file>", "frozen native dry-run output")
    .requiredOption("--apply-log <file>", "native apply stdout and stderr")
    .option("--json", "emit versioned machine output", false)
    .action(async (options) => {
      process.stdout.write(await executePrGcDiff(options));
    });

  program
    .command("worktrees")
    .description("Inventory worktree containers and native owner evidence without saving a plan.")
    .option(
      "--root <path>",
      "absolute worktree container; repeat to select multiple roots",
      collectOption,
      [],
    )
    .option(
      "--repo <path>",
      "include registrations from this repository; repeatable",
      collectOption,
      [],
    )
    .option(
      "--project-roots",
      "include .worktrees and .claude/worktrees under explicit repository owners",
      false,
    )
    .option(
      "--gwt-status-stdin",
      "read JSON from gwt finish-status --all --read-only on stdin",
      false,
    )
    .option(
      "--openclaw-pr-gc-stdin",
      "correlate OpenClaw scripts/pr gc --dry-run stdout with one project owner",
      false,
    )
    .option("--measure", "measure bounded logical checkout bytes", false)
    .option("--max-entries <count>", "measurement entry limit per checkout", "10000")
    .option("--redact", "redact paths in output", false)
    .option("--json", "emit versioned machine output", false)
    .action(async (options) => {
      process.stdout.write(
        await executeWorktreesCommand({
          ...options,
          home: homedir(),
          root: options.root,
          repo: options.repo,
        }),
      );
    });

  program
    .command("plan")
    .description(
      "Create a dry-run cleanup plan from a saved audit. Use git-inventory for Git storage and registrations.",
    )
    .requiredOption("--audit <path>", "saved audit JSON")
    .option("--config <path>", "explicit JSON config")
    .option("--output <path>", "write the plan atomically")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--max-risk <risk>", "safe, recoverable, destructive, or experimental")
    .action(
      async (options: {
        audit: string;
        config?: string;
        output?: string;
        stateDir?: string;
        maxRisk?: "safe" | "recoverable" | "destructive" | "experimental";
      }) => {
        const result = await executePlanCommand(options);
        process.stdout.write(result.output);
      },
    );

  program
    .command("clean")
    .description("Audit and plan repository-scoped agent cleanup.")
    .option("--profile <name>", "cleanup profile", "closeout")
    .option(
      "--repo <root>",
      "explicit repository root; repeat for fleet cleanup",
      collectOption,
      [],
    )
    .option("--home <path>", "home directory to audit")
    .option("--config <path>", "explicit JSON config")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--max-risk <risk>", "safe, recoverable, destructive, or experimental")
    .option("--apply", "apply the fresh plan after confirmation", false)
    .option("--yes", "authorize non-interactive apply", false)
    .option("--json", "emit a compact versioned cleanup summary", false)
    .action(
      async (options: {
        profile: string;
        repo: string[];
        home?: string;
        config?: string;
        stateDir?: string;
        maxRisk?: "safe" | "recoverable" | "destructive" | "experimental";
        apply: boolean;
        yes: boolean;
        json: boolean;
      }) => {
        if (!["closeout", "fleet"].includes(options.profile)) {
          throw new Error(`unsupported clean profile: ${options.profile}`);
        }
        if (options.profile === "closeout" && options.repo.length > 0) {
          throw new Error("clean --profile closeout does not accept --repo; use --profile fleet");
        }
        const controller = new AbortController();
        const interrupt = () => {
          controller.abort(new CommandInterruptedError("interrupted by SIGINT"));
        };
        process.on("SIGINT", interrupt);
        try {
          const input = {
            ...options,
            home: options.home ?? homedir(),
            signal: controller.signal,
          };
          const result =
            options.profile === "fleet"
              ? await executeCleanCommand({
                  ...input,
                  profile: "fleet",
                  repos: options.repo,
                })
              : await executeCleanCommand({
                  ...input,
                  profile: "closeout",
                });
          process.stdout.write(result.output);
          const exitCode = cleanCommandExitCode(result);
          if (exitCode !== undefined) {
            process.exitCode = exitCode;
          }
        } finally {
          process.removeListener("SIGINT", interrupt);
        }
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
    .option("--max-risk <risk>", "must match the risk ceiling used to create the plan")
    .action(
      async (options: {
        plan: string;
        config?: string;
        stateDir?: string;
        yes: boolean;
        json: boolean;
        maxRisk?: "safe" | "recoverable" | "destructive" | "experimental";
      }) => {
        const controller = new AbortController();
        const interrupt = () => {
          controller.abort(new CommandInterruptedError("interrupted by SIGINT"));
        };
        process.on("SIGINT", interrupt);
        try {
          const result = await executeApplyCommand({
            ...options,
            signal: controller.signal,
          });
          process.stdout.write(result.output);
          if (result.run.status === "interrupted") {
            process.exitCode = 130;
          } else if (["failed", "partial"].includes(result.run.status)) {
            process.exitCode = 2;
          }
        } finally {
          process.removeListener("SIGINT", interrupt);
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

  program
    .command("completion <shell>")
    .description("Generate shell completion for bash, zsh, or fish.")
    .action((shell: string) => {
      process.stdout.write(renderCompletion(shell));
    });

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
    .command("render")
    .description("Print a validated effective JSON profile after applying overrides in order.")
    .option("--home <path>", "home directory used for default resolution")
    .option("--config <path>", "input JSON config")
    .option(
      "--set </field/path=JSON>",
      "set a typed field or replace an entire array; repeatable",
      collectOption,
      [],
    )
    .action(async (options) => {
      process.stdout.write(
        await executeConfigRenderCommand(
          { home: options.home ?? homedir(), config: options.config },
          options.set,
        ),
      );
    });

  config
    .command("policy")
    .description(
      "Print effective cleanup options, built-in provider floors and inventory-only rule IDs as JSON.",
    )
    .option("--home <path>", "home directory used for default resolution")
    .option("--config <path>", "explicit JSON config")
    .action(async (options) => {
      process.stdout.write(
        await executeConfigPolicyCommand({
          home: options.home ?? homedir(),
          config: options.config,
        }),
      );
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

  program
    .command("undo <run-id>")
    .description("Restore recoverable actions from a cleanup run.")
    .option("--action <action-id>", "restore one action from the run")
    .option("--home <path>", "home directory used for state resolution")
    .option("--config <path>", "explicit JSON config")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--yes", "authorize non-interactive restore", false)
    .option("--json", "emit restored quarantine entries", false)
    .action(
      async (
        runId: string,
        options: {
          action?: string;
          home?: string;
          config?: string;
          stateDir?: string;
          yes: boolean;
          json: boolean;
        },
      ) => {
        const result = await executeUndoCommand({
          runId,
          home: options.home ?? homedir(),
          yes: options.yes,
          json: options.json,
          ...(options.action === undefined ? {} : { actionId: options.action }),
          ...(options.config === undefined ? {} : { config: options.config }),
          ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
        });
        process.stdout.write(result.output);
      },
    );

  program
    .command("purge")
    .description("Preview or permanently remove expired recovery backups.")
    .option("--expired", "select expired live quarantine entries", false)
    .option("--run <run-id>", "select live quarantine entries from one run")
    .option("--apply", "perform the destructive purge", false)
    .option("--home <path>", "home directory used for state resolution")
    .option("--config <path>", "explicit JSON config")
    .option("--state-dir <path>", "override the AgentRinse state directory")
    .option("--yes", "authorize non-interactive purge", false)
    .option("--json", "emit purge selection or results", false)
    .action(
      async (options: {
        expired: boolean;
        run?: string;
        apply: boolean;
        home?: string;
        config?: string;
        stateDir?: string;
        yes: boolean;
        json: boolean;
      }) => {
        const result = await executePurgeCommand({
          home: options.home ?? homedir(),
          expired: options.expired,
          apply: options.apply,
          yes: options.yes,
          json: options.json,
          ...(options.config === undefined ? {} : { config: options.config }),
          ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
          ...(options.run === undefined ? {} : { runId: options.run }),
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
