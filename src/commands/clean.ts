import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain } from "../adapters/git/porcelain.js";
import { createAuditAdapters, type AuditAdapterRegistryOptions } from "../adapters/registry.js";
import { confirmApply } from "./apply.js";
import { loadConfigForHome } from "../config/load.js";
import type { AgentRinseConfig } from "../config/schema.js";
import { actionRiskSchema, type ActionRisk, type PlannedAction } from "../contracts/action.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
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
const ACTION_RISKS = ["safe", "recoverable", "destructive", "experimental"] as const;
type FleetRepository = NonNullable<AuditAdapterRegistryOptions["gitRepositories"]>[number];

type CleanCommandBaseOptions = {
  home: string;
  config?: string;
  stateDir?: string;
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

export type CloseoutCleanCommandOptions = CleanCommandBaseOptions & {
  profile: "closeout";
  cwd?: string;
};

export type FleetCleanCommandOptions = CleanCommandBaseOptions & {
  profile: "fleet";
  repos: string[];
};

export type CleanCommandOptions = CloseoutCleanCommandOptions | FleetCleanCommandOptions;

export type MoleHandoff = {
  status: "available" | "absent" | "not-applicable";
  suggestions: string[];
};

type RunSummary = Pick<CleanupRun, "runId" | "status" | "reclaimedBytes"> & {
  journalPath: string;
  quarantinedBytes: number;
};

type SavedCleanSummary = {
  auditId: string;
  planId: string;
  auditPath: string;
  planPath: string;
  configPath: string;
  run?: RunSummary;
};

export type CloseoutSummary = SavedCleanSummary & {
  profile: "closeout";
  repositoryRoot: string;
  currentWorktree: string;
  worktrees: number;
  protectedWorktrees: number;
  eligibleActions: number;
  expectedReclaimBytes: number;
  pendingQuarantineBytes: number;
  mole: MoleHandoff;
};

export type FleetSummary = SavedCleanSummary & {
  profile: "fleet";
  repositoryCount: number;
  riskCeiling: "safe" | "recoverable";
  worktrees: number;
  protectedWorktrees: number;
  candidateActions: number;
  selectedActions: number;
  excludedByRisk: number;
  candidatesByRisk: Record<ActionRisk, number>;
  candidateQuarantineBytes: number;
  selectedQuarantineBytes: number;
  unknownFindings: number;
  topBlockers: { code: string; count: number }[];
};

export type CleanSummary = CloseoutSummary | FleetSummary;

export type CleanCommandResult<TSummary extends CleanSummary = CleanSummary> = {
  audit: AuditReport;
  plan: CleanupPlan;
  run?: CleanupRun;
  status: "ok" | "degraded" | "failed";
  summary: TSummary;
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

export function cleanCommandStatus(
  audit: Pick<AuditReport, "diagnostics" | "probes">,
  run?: Pick<CleanupRun, "status">,
): CleanCommandResult["status"] {
  if (run !== undefined && ["failed", "interrupted", "partial"].includes(run.status)) {
    return "failed";
  }
  return audit.probes.some((probe) => probe.status === "degraded") || audit.diagnostics.length > 0
    ? "degraded"
    : "ok";
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
  gitRoot: string,
  worktrees: string[],
  maxRisk: ActionRisk | undefined,
): AgentRinseConfig {
  const scoped = structuredClone(config);
  for (const id of ["cursor", "copilot", "zed", "opencode", "grok", "runtime", "docker"] as const) {
    scoped.adapters[id] = { enabled: false };
  }
  scoped.adapters.git = { enabled: true, root: gitRoot };
  scoped.artifacts.projects = scoped.artifacts.projects.filter((project) =>
    worktrees.some((worktree) => isInside(worktree, project.root)),
  );
  if (maxRisk !== undefined) {
    scoped.plan.maxRisk = maxRisk;
  }
  return scoped;
}

async function fleetRepositories(
  repos: readonly string[],
  runCommand: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<{ repositories: FleetRepository[]; worktrees: string[] }> {
  if (repos.some((repo) => !isAbsolute(repo))) {
    throw new Error("clean --profile fleet requires absolute --repo paths");
  }
  const requested = [...new Set(repos)].sort();
  const valid = new Map<string, FleetRepository>();
  const invalid: FleetRepository[] = [];
  const failed = (root: string, code: string, error: unknown): FleetRepository => ({
    root,
    discovery: {
      diagnostic: {
        severity: "warning",
        code,
        message: error instanceof Error ? error.message : String(error),
        adapter: "git",
      },
    },
  });

  for (const repo of requested) {
    let commonDir: string;
    try {
      const commonOutput = (
        await runCommand("git", [
          "-C",
          repo,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).stdout.trim();
      commonDir = await realpath(commonOutput);
    } catch (error) {
      invalid.push(failed(repo, "GIT_PROBE_FAILED", error));
      continue;
    }
    if (valid.has(commonDir)) {
      continue;
    }
    try {
      const output = (
        await runCommand("git", ["-C", repo, "worktree", "list", "--porcelain", "-z"])
      ).stdout;
      valid.set(commonDir, {
        root: repo,
        discovery: { records: parseWorktreePorcelain(output) },
      });
    } catch (error) {
      valid.set(commonDir, failed(repo, "GIT_REPOSITORY_INSPECTION_FAILED", error));
    }
  }

  const repositories = [...valid.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, repository]) => repository)
    .concat(invalid.sort((left, right) => left.root!.localeCompare(right.root!)));
  const worktrees = new Set<string>();
  for (const repository of valid.values()) {
    for (const record of repository.discovery?.records ?? []) {
      worktrees.add(resolve(record.path));
    }
  }
  return { repositories, worktrees: [...worktrees].sort() };
}

function quarantineBytes(actions: readonly PlannedAction[]): number {
  return actions.reduce(
    (total, action) =>
      total + ("pendingQuarantineBytes" in action ? action.pendingQuarantineBytes : 0),
    0,
  );
}

function fleetBlockers(audit: AuditReport): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { roots } of audit.findings) {
    for (const { code } of roots) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, 5);
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
    `Immediate reclaim: ${summary.expectedReclaimBytes} bytes`,
    `Pending quarantine: ${summary.pendingQuarantineBytes} bytes`,
    `Audit: ${summary.auditPath}`,
    `Plan: ${summary.planPath}`,
    `Config: ${summary.configPath}`,
  ];
  if (summary.run !== undefined) {
    lines.push(
      `Run: ${summary.run.status} (${summary.run.reclaimedBytes} reclaimed, ${summary.run.quarantinedBytes} quarantined bytes)`,
      `Journal: ${summary.run.journalPath}`,
    );
  }
  if (summary.mole.suggestions.length > 0) {
    lines.push("", "Mole handoff:", ...summary.mole.suggestions.map((item) => `  ${item}`));
  }
  return `${lines.join("\n")}\n`;
}

function renderFleet(summary: FleetSummary, diagnostics: readonly Diagnostic[]): string {
  const riskCounts = ACTION_RISKS.map((risk) => `${risk}=${summary.candidatesByRisk[risk]}`).join(
    ", ",
  );
  const lines = [
    "AgentRinse fleet cleanup",
    "",
    `Repositories: ${summary.repositoryCount}`,
    `Worktrees: ${summary.worktrees} (${summary.protectedWorktrees} protected)`,
    `Risk ceiling: ${summary.riskCeiling}`,
    `Candidate actions: ${summary.candidateActions} (${riskCounts})`,
    `Selected actions: ${summary.selectedActions} (${summary.excludedByRisk} excluded by risk)`,
    `Candidate quarantine: ${summary.candidateQuarantineBytes} bytes`,
    `Selected quarantine: ${summary.selectedQuarantineBytes} bytes`,
    `Unknown findings: ${summary.unknownFindings}`,
    `Audit: ${summary.auditPath}`,
    `Plan: ${summary.planPath}`,
    `Config: ${summary.configPath}`,
  ];
  if (summary.topBlockers.length > 0) {
    lines.push(
      "",
      "Top blockers:",
      ...summary.topBlockers.map((blocker) => `  ${blocker.code}: ${blocker.count}`),
    );
  }
  if (diagnostics.length > 0) {
    lines.push(
      "",
      "Diagnostics:",
      ...diagnostics.map((diagnostic) => `  ${diagnostic.code}: ${diagnostic.message}`),
    );
  }
  if (summary.run !== undefined) {
    lines.push(
      "",
      `Run: ${summary.run.status} (${summary.run.reclaimedBytes} reclaimed, ${summary.run.quarantinedBytes} quarantined bytes)`,
      `Journal: ${summary.run.journalPath}`,
    );
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

export function executeCleanCommand(
  options: CloseoutCleanCommandOptions,
): Promise<CleanCommandResult<CloseoutSummary>>;
export function executeCleanCommand(
  options: FleetCleanCommandOptions,
): Promise<CleanCommandResult<FleetSummary>>;
export async function executeCleanCommand(
  options: CleanCommandOptions,
): Promise<CleanCommandResult> {
  if (options.json && options.apply && !options.yes) {
    throw new Error("clean --json --apply requires --yes");
  }
  if (options.profile === "fleet") {
    const requirement =
      options.repos.length === 0
        ? "at least one --repo"
        : options.maxRisk === undefined
          ? "--max-risk safe or recoverable"
          : undefined;
    if (requirement !== undefined) {
      throw new Error(`clean --profile fleet requires ${requirement}`);
    }
    if (options.maxRisk !== "safe" && options.maxRisk !== "recoverable") {
      throw new Error("clean --profile fleet supports only --max-risk safe or recoverable");
    }
  }
  const runCommand = options.dependencies?.runCommand ?? defaultRunCommand;
  const platform = options.dependencies?.platform ?? process.platform;
  const clock = options.dependencies?.now ?? (() => new Date());
  const home = resolve(options.home);
  let repositories: FleetRepository[];
  let worktrees: string[];
  let currentWorktree: string | undefined;
  let repositoryRoot: string | undefined;
  if (options.profile === "closeout") {
    const cwd = resolve(options.cwd ?? process.cwd());
    currentWorktree = (
      await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
    ).stdout.trim();
    if (currentWorktree === "") {
      throw new Error("closeout requires a Git worktree");
    }
    const worktreeOutput = (
      await runCommand("git", ["-C", currentWorktree, "worktree", "list", "--porcelain", "-z"])
    ).stdout;
    worktrees = parseWorktreePorcelain(worktreeOutput).map((record) => resolve(record.path));
    repositoryRoot = worktrees[0] ?? currentWorktree;
    repositories = [{ root: currentWorktree }];
  } else {
    const fleet = await fleetRepositories(options.repos, runCommand);
    repositories = fleet.repositories;
    worktrees = fleet.worktrees;
  }
  const { config } = await loadConfigForHome(home, options.config);
  const maxRisk =
    options.maxRisk === undefined ? undefined : actionRiskSchema.parse(options.maxRisk);
  const scoped = scopedConfig(config, repositories[0]!.root!, worktrees, maxRisk);
  const roots =
    options.profile === "closeout"
      ? [
          {
            path: currentWorktree!,
            code: "current-worktree",
            source: "closeout",
            detail: "The worktree running the closeout profile is protected.",
            scope: "exact" as const,
            resourceKinds: ["git-worktree" as const],
          },
          {
            path: currentWorktree!,
            code: "current-worktree",
            source: "closeout",
            detail: "Artifacts inside the current worktree are protected.",
            scope: "subtree" as const,
            resourceKinds: ["build-artifact" as const],
          },
        ]
      : [];
  const audit = await runAudit({
    home,
    config: scoped,
    adapters: createAuditAdapters(scoped, platform, {
      providerInventory: false,
      roots,
      ...(options.profile === "fleet" ? { gitRepositories: repositories } : {}),
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
  if (options.apply && plan.actions.length > 0) {
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
      dependencies: {
        clock,
        loadCurrentConfig: async () =>
          scopedConfig(
            (await loadConfigForHome(home, options.config)).config,
            repositories[0]!.root!,
            worktrees,
            maxRisk,
          ),
      },
    });
    run = result.run;
    journalPath = result.journalPath;
  }

  const gitFindings = audit.findings.filter((finding) => finding.resource.kind === "git-worktree");
  const runSummary: { run?: RunSummary } =
    run === undefined || journalPath === undefined
      ? {}
      : {
          run: {
            runId: run.runId,
            status: run.status,
            journalPath,
            reclaimedBytes: run.reclaimedBytes,
            quarantinedBytes: run.quarantinedBytes ?? 0,
          },
        };
  const savedSummary: SavedCleanSummary = {
    auditId: audit.auditId,
    planId: plan.planId,
    auditPath,
    planPath,
    configPath,
    ...runSummary,
  };
  const summary: CleanSummary =
    options.profile === "closeout"
      ? {
          ...savedSummary,
          profile: "closeout",
          repositoryRoot: repositoryRoot!,
          currentWorktree: currentWorktree!,
          worktrees: gitFindings.length,
          protectedWorktrees: gitFindings.filter((finding) => finding.state !== "eligible").length,
          eligibleActions: plan.actions.length,
          expectedReclaimBytes: plan.expectedReclaimBytes,
          pendingQuarantineBytes: plan.pendingQuarantineBytes ?? 0,
          mole: await moleHandoff(platform, runCommand),
        }
      : (() => {
          const candidates = audit.findings.flatMap((finding) => finding.candidateActions);
          const candidatesByRisk = Object.fromEntries(
            ACTION_RISKS.map((risk) => [
              risk,
              candidates.filter((action) => action.risk === risk).length,
            ]),
          ) as Record<ActionRisk, number>;
          return {
            ...savedSummary,
            profile: "fleet" as const,
            repositoryCount: repositories.length,
            riskCeiling: maxRisk as "safe" | "recoverable",
            worktrees: gitFindings.length,
            protectedWorktrees: gitFindings.filter((finding) => finding.state !== "eligible")
              .length,
            candidateActions: candidates.length,
            selectedActions: plan.actions.length,
            excludedByRisk: candidates.length - plan.actions.length,
            candidatesByRisk,
            candidateQuarantineBytes: quarantineBytes(candidates),
            selectedQuarantineBytes: quarantineBytes(plan.actions),
            unknownFindings: audit.findings.filter((finding) => finding.state === "unknown").length,
            topBlockers: fleetBlockers(audit),
          };
        })();
  const startedAt = audit.startedAt;
  const completedAt = clock().toISOString();
  const status = cleanCommandStatus(audit, run);
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
      : summary.profile === "closeout"
        ? renderCloseout(summary)
        : renderFleet(summary, audit.diagnostics),
  };
}
