import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import { createAuditAdapters } from "../adapters/registry.js";
import { confirmApply } from "./apply.js";
import { loadConfigForHome } from "../config/load.js";
import type { AgentRinseConfig } from "../config/schema.js";
import { actionRiskSchema, type ActionRisk } from "../contracts/action.js";
import type { CleanupPlan } from "../contracts/plan.js";
import type { AuditReport } from "../contracts/report.js";
import type { CleanupRun } from "../contracts/run.js";
import { applyCleanupPlan } from "../core/apply.js";
import { runAudit } from "../core/audit.js";
import { CommandInterruptedError } from "../core/interruption.js";
import { createCleanupPlan } from "../core/plan.js";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import { writeJsonAtomic } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";

const execFileAsync = promisify(execFile);

export type CleanCommandOptions = {
  home: string;
  config?: string;
  stateDir?: string;
  profile: "closeout";
  cwd?: string;
  apply: boolean;
  yes: boolean;
  json: boolean;
  maxRisk?: ActionRisk;
  signal?: AbortSignal;
  dependencies?: {
    platform?: NodeJS.Platform;
    now?: () => Date;
    runCommand?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  };
};

export type MoleHandoff = {
  status: "available" | "absent" | "not-applicable";
  suggestions: string[];
};

export type CloseoutSummary = {
  profile: "closeout";
  repositoryRoot: string;
  currentWorktree: string;
  auditId: string;
  planId: string;
  auditPath: string;
  planPath: string;
  configPath: string;
  worktrees: number;
  protectedWorktrees: number;
  eligibleActions: number;
  expectedReclaimBytes: number;
  mole: MoleHandoff;
  run?: {
    runId: string;
    status: CleanupRun["status"];
    journalPath: string;
    reclaimedBytes: number;
  };
};

export type CleanCommandResult = {
  audit: AuditReport;
  plan: CleanupPlan;
  run?: CleanupRun;
  status: "ok" | "degraded" | "failed";
  summary: CloseoutSummary;
  output: string;
};

export function cleanCommandExitCode(
  result: Pick<CleanCommandResult, "run" | "status">,
): number | undefined {
  if (result.run?.status === "interrupted") {
    return 130;
  }
  if (result.run !== undefined && ["failed", "partial"].includes(result.run.status)) {
    return 2;
  }
  return result.status === "degraded" ? 1 : undefined;
}

async function defaultRunCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function isInside(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function scopedConfig(
  config: AgentRinseConfig,
  currentWorktree: string,
  worktrees: string[],
  maxRisk: ActionRisk | undefined,
): AgentRinseConfig {
  const scoped = structuredClone(config);
  for (const id of ["cursor", "copilot", "zed", "opencode", "grok", "runtime", "docker"] as const) {
    scoped.adapters[id] = { enabled: false };
  }
  scoped.adapters.git = { enabled: true, root: currentWorktree };
  scoped.artifacts.projects = scoped.artifacts.projects.filter((project) =>
    worktrees.some((worktree) => isInside(worktree, project.root)),
  );
  if (maxRisk !== undefined) {
    scoped.plan.maxRisk = maxRisk;
  }
  return scoped;
}

async function moleHandoff(
  platform: NodeJS.Platform,
  runCommand: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<MoleHandoff> {
  if (platform !== "darwin") {
    return { status: "not-applicable", suggestions: [] };
  }
  try {
    await runCommand("mo", ["--version"]);
    return {
      status: "available",
      suggestions: ["mo purge --dry-run", "mo clean --dry-run"],
    };
  } catch {
    return {
      status: "absent",
      suggestions: ["Install Mole to preview broad macOS cleanup outside AgentRinse."],
    };
  }
}

function renderCloseout(summary: CloseoutSummary): string {
  const lines = [
    "AgentRinse closeout",
    "",
    `Repository: ${summary.repositoryRoot}`,
    `Worktrees: ${summary.worktrees} (${summary.protectedWorktrees} protected)`,
    `Eligible actions: ${summary.eligibleActions}`,
    `Expected reclaim: ${summary.expectedReclaimBytes} bytes`,
    `Audit: ${summary.auditPath}`,
    `Plan: ${summary.planPath}`,
    `Config: ${summary.configPath}`,
  ];
  if (summary.run !== undefined) {
    lines.push(
      `Run: ${summary.run.status} (${summary.run.reclaimedBytes} bytes)`,
      `Journal: ${summary.run.journalPath}`,
    );
  }
  if (summary.mole.suggestions.length > 0) {
    lines.push("", "Mole handoff:", ...summary.mole.suggestions.map((item) => `  ${item}`));
  }
  return `${lines.join("\n")}\n`;
}

function interruptionFrom(signal?: AbortSignal): CommandInterruptedError | undefined {
  if (signal?.aborted !== true) {
    return undefined;
  }
  return signal.reason instanceof CommandInterruptedError
    ? signal.reason
    : new CommandInterruptedError("clean interrupted");
}

export async function executeCleanCommand(
  options: CleanCommandOptions,
): Promise<CleanCommandResult> {
  if (options.profile !== "closeout") {
    throw new Error(`unsupported clean profile: ${options.profile}`);
  }
  if (options.json && options.apply && !options.yes) {
    throw new Error("clean --json --apply requires --yes");
  }
  const runCommand = options.dependencies?.runCommand ?? defaultRunCommand;
  const platform = options.dependencies?.platform ?? process.platform;
  const clock = options.dependencies?.now ?? (() => new Date());
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home);
  const currentWorktree = (
    await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  if (currentWorktree === "") {
    throw new Error("closeout requires a Git worktree");
  }
  const worktreeOutput = (
    await runCommand("git", ["-C", currentWorktree, "worktree", "list", "--porcelain", "-z"])
  ).stdout;
  const worktrees = parseWorktreePorcelain(worktreeOutput).map((record) => resolve(record.path));
  const repositoryRoot = worktrees[0] ?? currentWorktree;
  const { config } = await loadConfigForHome(home, options.config);
  const maxRisk =
    options.maxRisk === undefined ? undefined : actionRiskSchema.parse(options.maxRisk);
  const scoped = scopedConfig(config, currentWorktree, worktrees, maxRisk);
  const audit = await runAudit({
    home,
    config: scoped,
    adapters: createAuditAdapters(scoped, platform, {
      providerInventory: false,
      roots: [
        {
          path: currentWorktree,
          code: "current-worktree",
          source: "closeout",
          detail: "The worktree running the closeout profile is protected.",
        },
      ],
    }),
    now: clock,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const plan = createCleanupPlan(audit, scoped, clock());
  const layout = stateLayout(resolveStateRoot(home, options.stateDir));
  const auditPath = resolve(layout.audits, `${audit.auditId}.json`);
  const planPath = resolve(layout.plans, `${plan.planId}.json`);
  const configPath = resolve(layout.plans, `${plan.planId}.config.json`);
  await writeJsonAtomic(auditPath, audit, {
    privateDirectories: [layout.root, layout.audits],
  });
  await writeJsonAtomic(planPath, plan, {
    privateDirectories: [layout.root, layout.plans],
  });
  await writeJsonAtomic(configPath, scoped, {
    privateDirectories: [layout.root, layout.plans],
  });

  let run: CleanupRun | undefined;
  let journalPath: string | undefined;
  if (options.apply) {
    const interruption = interruptionFrom(options.signal);
    if (interruption !== undefined) {
      throw interruption;
    }
    if (!options.yes && !(await confirmApply(plan.actions.length, options.signal))) {
      throw new Error("clean apply cancelled");
    }
    const result = await applyCleanupPlan({
      input: plan,
      config: scoped,
      stateRoot: layout.root,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      dependencies: { clock },
    });
    run = result.run;
    journalPath = result.journalPath;
  }

  const gitFindings = audit.findings.filter((finding) => finding.resource.kind === "git-worktree");
  const summary: CloseoutSummary = {
    profile: "closeout",
    repositoryRoot,
    currentWorktree,
    auditId: audit.auditId,
    planId: plan.planId,
    auditPath,
    planPath,
    configPath,
    worktrees: gitFindings.length,
    protectedWorktrees: gitFindings.filter((finding) => finding.state !== "eligible").length,
    eligibleActions: plan.actions.length,
    expectedReclaimBytes: plan.expectedReclaimBytes,
    mole: await moleHandoff(platform, runCommand),
    ...(run === undefined || journalPath === undefined
      ? {}
      : {
          run: {
            runId: run.runId,
            status: run.status,
            journalPath,
            reclaimedBytes: run.reclaimedBytes,
          },
        }),
  };
  const startedAt = audit.startedAt;
  const completedAt = clock().toISOString();
  const status =
    run !== undefined && ["failed", "partial"].includes(run.status)
      ? "failed"
      : audit.probes.some((probe) => probe.status === "degraded") || audit.diagnostics.length > 0
        ? "degraded"
        : "ok";
  return {
    audit,
    plan,
    ...(run === undefined ? {} : { run }),
    status,
    summary,
    output: options.json
      ? jsonDocument(
          createCommandEnvelope({
            command: "clean",
            startedAt,
            completedAt,
            status,
            data: summary,
            diagnostics: audit.diagnostics,
          }),
        )
      : renderCloseout(summary),
  };
}
