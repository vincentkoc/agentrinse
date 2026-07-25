import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ZodType } from "zod";

import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { loadConfigForHome } from "../config/load.js";
import type { AgentRinseConfig } from "../config/schema.js";
import { cleanupPlanSchema } from "../contracts/plan.js";
import { auditReportSchema } from "../contracts/report.js";
import { cleanupRunSchema } from "../contracts/run.js";
import { quarantineEntrySchema } from "../contracts/quarantine.js";
import { databaseBackupEntrySchema } from "../contracts/database-backup.js";
import { providerFileQuarantineEntrySchema } from "../contracts/provider-file-quarantine.js";
import { doctorReportSchema, type DoctorCheck, type DoctorReport } from "../contracts/doctor.js";
import { readJsonFile } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";
import { inspectApplyLock, type LockInspectionDependencies } from "../state/lock.js";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type DoctorCommandDependencies = {
  now?: () => Date;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  runCommand?: (command: string, args: string[]) => Promise<CommandResult>;
  readProcessStat?: () => Promise<string>;
  currentUid?: () => number | undefined;
  lock?: LockInspectionDependencies;
};

export type DoctorCommandOptions = {
  home: string;
  config?: string | undefined;
  stateDir?: string | undefined;
  json: boolean;
  dependencies?: DoctorCommandDependencies | undefined;
};

export type DoctorCommandResult = {
  report: DoctorReport;
  output: string;
};

async function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 5_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function nearestExistingPath(path: string): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

function reportStatus(checks: DoctorCheck[]): DoctorReport["status"] {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }
  return checks.some((check) => check.status === "warning") ? "warning" : "ok";
}

function renderDoctor(report: DoctorReport): string {
  const lines = [`AgentRinse doctor: ${report.status}`, ""];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(7)} ${check.id.padEnd(24)} ${check.summary}`);
    if (check.detail !== undefined) {
      lines.push(`        ${check.detail}`);
    }
    if (check.remediation !== undefined) {
      lines.push(`        remediation: ${check.remediation}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function platformCheck(platform: NodeJS.Platform): DoctorCheck {
  if (platform === "darwin") {
    return {
      id: "platform",
      status: "pass",
      summary: "macOS supports audit, artifact cleanup, and recoverable worktree quarantine",
    };
  }
  if (platform === "linux") {
    return {
      id: "platform",
      status: "pass",
      summary: "Linux supports audit, artifact cleanup, and recoverable worktree quarantine",
    };
  }
  if (platform === "win32") {
    return {
      id: "platform",
      status: "warning",
      summary: "native Windows is audit-only",
      remediation: "Use WSL for supported safe artifact cleanup.",
    };
  }
  return {
    id: "platform",
    status: "error",
    summary: `platform ${platform} is unsupported`,
  };
}

async function configChecks(
  options: DoctorCommandOptions,
  environment: NodeJS.ProcessEnv,
): Promise<{ checks: DoctorCheck[]; config: AgentRinseConfig }> {
  try {
    const loaded = await loadConfigForHome(options.home, options.config, environment);
    return {
      config: loaded.config,
      checks: [
        loaded.exists
          ? {
              id: "config",
              status: "pass",
              summary: "configuration is valid",
              detail: loaded.path,
            }
          : {
              id: "config",
              status: "warning",
              summary: "default configuration is in use",
              detail: `No configuration file exists at ${loaded.path}.`,
              remediation: "Run agentrinse config init before configuring cleanup roots.",
            },
      ],
    };
  } catch (error) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      checks: [
        {
          id: "config",
          status: "error",
          summary: "configuration could not be loaded",
          detail: errorMessage(error),
          remediation: "Fix the JSON or run agentrinse config init at a new path.",
        },
      ],
    };
  }
}

async function stateCheck(root: string, currentUid?: number): Promise<DoctorCheck> {
  try {
    const existing = await nearestExistingPath(root);
    const stats = await lstat(existing);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return {
        id: "state",
        status: "error",
        summary: "state path resolves through a non-directory or symlink",
        detail: existing,
      };
    }
    if (existing === resolve(root) && currentUid !== undefined && stats.uid !== currentUid) {
      return {
        id: "state",
        status: "error",
        summary: "state directory is not owned by the current user",
        detail: root,
        remediation: "Choose or create a state directory owned by the current user.",
      };
    }
    await access(existing, constants.R_OK | constants.W_OK | constants.X_OK);
    return {
      id: "state",
      status: "pass",
      summary:
        existing === resolve(root)
          ? "state directory is readable and writable"
          : "state directory can be created",
      detail: existing === resolve(root) ? root : `Nearest writable parent: ${existing}`,
    };
  } catch (error) {
    return {
      id: "state",
      status: "error",
      summary: "state directory is not usable",
      detail: errorMessage(error),
      remediation: "Choose a readable, writable local state directory.",
    };
  }
}

async function processOwnershipCheck(
  platform: NodeJS.Platform,
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
  readProcessStat: () => Promise<string>,
): Promise<DoctorCheck> {
  if (platform === "win32") {
    return {
      id: "process-ownership",
      status: "warning",
      summary: "native Windows process ownership proof is unavailable",
    };
  }
  let procfsError: unknown;
  if (platform === "linux") {
    try {
      await readProcessStat();
    } catch (error) {
      procfsError = error;
    }
  }
  try {
    await runCommand("lsof", ["-v"]);
    return {
      id: "process-ownership",
      status: "pass",
      summary:
        platform === "linux" && procfsError === undefined
          ? "procfs ownership proof and lsof fallback are available"
          : platform === "linux"
            ? "lsof fallback ownership proof is available"
            : "lsof process ownership proof is available",
      ...(procfsError === undefined
        ? {}
        : { detail: `procfs ownership proof is unavailable: ${errorMessage(procfsError)}` }),
    };
  } catch (error) {
    return {
      id: "process-ownership",
      status: "error",
      summary:
        platform === "linux" && procfsError !== undefined
          ? "Linux process ownership proof is unavailable"
          : platform === "linux"
            ? "lsof fallback is unavailable"
            : "lsof process ownership proof is unavailable",
      detail:
        procfsError === undefined
          ? errorMessage(error)
          : `procfs: ${errorMessage(procfsError)}; lsof: ${errorMessage(error)}`,
      remediation: "Install lsof before applying cleanup plans.",
    };
  }
}

async function recoveryMutexCheck(
  platform: NodeJS.Platform,
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<DoctorCheck> {
  if (platform !== "darwin" && platform !== "linux") {
    return {
      id: "recovery-mutex",
      status: "pass",
      summary: "stale-lock recovery is not available on this platform",
    };
  }
  const command = platform === "darwin" ? "lockf" : "flock";
  try {
    const result = await runCommand("sh", ["-c", `command -v ${command}`]);
    return {
      id: "recovery-mutex",
      status: "pass",
      summary: `${result.stdout.trim() || command} provides crash-safe stale-lock recovery`,
    };
  } catch (error) {
    return {
      id: "recovery-mutex",
      status: "error",
      summary: `${command} is unavailable`,
      detail: errorMessage(error),
      remediation:
        platform === "darwin"
          ? "Restore the macOS lockf utility before recovering stale locks."
          : "Install util-linux to provide flock before recovering stale locks.",
    };
  }
}

async function gitChecks(
  config: AgentRinseConfig,
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const result = await runCommand("git", ["--version"]);
    const version = result.stdout.trim();
    checks.push({
      id: "git",
      status: "pass",
      summary: version === "" ? "Git is available" : version,
    });
  } catch (error) {
    return [
      {
        id: "git",
        status: "error",
        summary: "Git is unavailable",
        detail: errorMessage(error),
        remediation: "Install Git before enabling worktree inventory.",
      },
    ];
  }

  const git = config.adapters.git;
  if (git?.enabled !== true) {
    checks.push({
      id: "git:porcelain",
      status: "pass",
      summary: "Git worktree adapter is disabled",
    });
    return checks;
  }
  if (git.root === undefined) {
    checks.push({
      id: "git:porcelain",
      status: "warning",
      summary: "Git worktree adapter has no explicit repository root",
      remediation: "Set adapters.git.root or disable the Git adapter.",
    });
    return checks;
  }

  try {
    await runCommand("git", ["-C", resolve(git.root), "worktree", "list", "--porcelain", "-z"]);
    checks.push({
      id: "git:porcelain",
      status: "pass",
      summary: "Git worktree porcelain is available",
      detail: resolve(git.root),
    });
  } catch (error) {
    checks.push({
      id: "git:porcelain",
      status: "error",
      summary: "Git worktree porcelain failed",
      detail: errorMessage(error),
      remediation: "Fix the configured Git root before enabling worktree inventory.",
    });
  }
  return checks;
}

async function dockerCheck(
  enabled: boolean,
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<DoctorCheck> {
  try {
    await runCommand("docker", ["--version"]);
  } catch (error) {
    return {
      id: "docker",
      status: enabled ? "warning" : "pass",
      summary: enabled ? "Docker CLI is unavailable" : "Docker is not installed (optional)",
      ...(enabled
        ? {
            detail: errorMessage(error),
            remediation: "Install Docker or disable the Docker adapter.",
          }
        : {}),
    };
  }

  try {
    const [context, version] = await Promise.all([
      runCommand("docker", ["context", "show"]),
      runCommand("docker", ["version", "--format", "{{.Server.Version}}"]),
    ]);
    return {
      id: "docker",
      status: "pass",
      summary: `Docker daemon ${version.stdout.trim() || "available"}`,
      detail: `Context: ${context.stdout.trim() || "unknown"}`,
    };
  } catch (error) {
    return {
      id: "docker",
      status: enabled ? "warning" : "pass",
      summary: enabled
        ? "Docker CLI is installed but its daemon or context is unavailable"
        : "Docker daemon is unavailable (optional)",
      ...(enabled
        ? {
            detail: errorMessage(error),
            remediation: "Start Docker or disable the Docker adapter.",
          }
        : {}),
    };
  }
}

async function moleCheck(
  platform: NodeJS.Platform,
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<DoctorCheck> {
  if (platform !== "darwin") {
    return {
      id: "mole",
      status: "pass",
      summary: "Mole handoff is not applicable on this platform",
    };
  }
  try {
    const result = await runCommand("mo", ["--version"]);
    return {
      id: "mole",
      status: "pass",
      summary: result.stdout.trim() || result.stderr.trim() || "Mole is available",
      detail: "Mole is optional and remains an external handoff.",
    };
  } catch {
    return {
      id: "mole",
      status: "pass",
      summary: "Mole is not installed (optional)",
    };
  }
}

async function providerChecks(
  home: string,
  config: AgentRinseConfig,
  platform: NodeJS.Platform,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const spec of Object.values(PROVIDER_SPECS).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const configured = config.adapters[spec.id];
    if (configured?.enabled === false) {
      checks.push({
        id: `provider:${spec.id}`,
        status: "pass",
        summary: `${spec.displayName} adapter is disabled`,
      });
      continue;
    }
    const root = resolve(configured?.root ?? spec.defaultRoot(home, platform));
    try {
      const stats = await lstat(root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        checks.push({
          id: `provider:${spec.id}`,
          status: "warning",
          summary: `${spec.displayName} root is not a real directory`,
          detail: root,
        });
        continue;
      }
      await access(root, constants.R_OK | constants.X_OK);
      checks.push({
        id: `provider:${spec.id}`,
        status: "pass",
        summary: `${spec.displayName} root is readable`,
        detail: root,
      });
    } catch (error) {
      const missing = errorCode(error) === "ENOENT";
      checks.push({
        id: `provider:${spec.id}`,
        status: configured?.root !== undefined && missing ? "warning" : missing ? "pass" : "error",
        summary: missing
          ? `${spec.displayName} root is absent`
          : `${spec.displayName} root is unreadable`,
        detail: root,
        ...(configured?.root !== undefined && missing
          ? { remediation: "Fix or remove the explicit provider root." }
          : {}),
      });
    }
  }
  return checks;
}

async function databaseMaintenanceCheck(
  runCommand: (command: string, args: string[]) => Promise<CommandResult>,
): Promise<DoctorCheck> {
  const available: string[] = [];
  const missing: string[] = [];
  for (const [command, args] of [
    ["sqlite3", ["--version"]],
    ["lsof", ["-v"]],
  ] as const) {
    try {
      const result = await runCommand(command, [...args]);
      available.push(result.stdout.trim().split(/\s+/u)[0] || command);
    } catch {
      missing.push(command);
    }
  }
  return missing.length === 0
    ? {
        id: "database-maintenance",
        status: "pass",
        summary: "offline database maintenance tools are available",
        detail: available.join(", "),
      }
    : {
        id: "database-maintenance",
        status: "warning",
        summary: `offline database maintenance is unavailable (${missing.join(", ")})`,
        remediation: "Install sqlite3 and lsof before using audit --allow-offline-vacuum.",
      };
}

async function artifactChecks(config: AgentRinseConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [index, project] of config.artifacts.projects.entries()) {
    const root = resolve(project.root);
    try {
      const stats = await lstat(root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("configured artifact root must be a real directory");
      }
      await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
      checks.push({
        id: `artifact-root:${index}`,
        status: "pass",
        summary: "artifact root supports same-parent isolation",
        detail: root,
      });
    } catch (error) {
      checks.push({
        id: `artifact-root:${index}`,
        status: "error",
        summary: "artifact root is not safe for cleanup",
        detail: `${root}: ${errorMessage(error)}`,
      });
    }
  }
  if (checks.length === 0) {
    checks.push({
      id: "artifact-roots",
      status: "pass",
      summary: "no artifact cleanup roots are configured",
    });
  }
  return checks;
}

async function schemaDirectoryCheck<T>(
  id: string,
  directory: string,
  schema: ZodType<T>,
): Promise<DoctorCheck> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { id, status: "pass", summary: "no persisted records found" };
    }
    return {
      id,
      status: "error",
      summary: "persisted records could not be listed",
      detail: errorMessage(error),
    };
  }

  const failures: string[] = [];
  for (const name of names) {
    try {
      schema.parse(await readJsonFile(join(directory, name)));
    } catch {
      failures.push(name);
    }
  }
  return failures.length === 0
    ? { id, status: "pass", summary: `${names.length} persisted record(s) are compatible` }
    : {
        id,
        status: "error",
        summary: `${failures.length} persisted record(s) are incompatible`,
        detail: failures.join(", "),
        remediation: "Inspect the records before moving or removing any AgentRinse state.",
      };
}

async function lockCheck(
  locksDirectory: string,
  dependencies?: LockInspectionDependencies,
): Promise<DoctorCheck> {
  let status: Awaited<ReturnType<typeof inspectApplyLock>>;
  try {
    status = await inspectApplyLock(locksDirectory, dependencies);
  } catch (error) {
    return {
      id: "apply-lock",
      status: "error",
      summary: "apply lock could not be inspected",
      detail: errorMessage(error),
      remediation: "Do not apply or recover until the lock owner can be inspected.",
    };
  }
  if (status.status === "absent") {
    return { id: "apply-lock", status: "pass", summary: "no apply lock is present" };
  }
  if (status.status === "active") {
    return {
      id: "apply-lock",
      status: "warning",
      summary: `an apply run is active (PID ${status.owner.pid})`,
      detail: `run ${status.owner.runId}`,
    };
  }
  if (status.status === "stale") {
    return {
      id: "apply-lock",
      status: "warning",
      summary: "a proven stale apply lock is present",
      detail: status.reason,
      remediation: "Review agentrinse lock status, then run agentrinse lock recover --yes.",
    };
  }
  return {
    id: "apply-lock",
    status: "error",
    summary: `apply lock status is ${status.status}`,
    detail: status.reason,
    remediation: "Do not remove the lock until its owner can be proven stale.",
  };
}

export async function executeDoctorCommand(
  options: DoctorCommandOptions,
): Promise<DoctorCommandResult> {
  const dependencies = options.dependencies ?? {};
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? process.env;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const root = resolveStateRoot(options.home, options.stateDir, environment);
  const layout = stateLayout(root);
  const loaded = await configChecks(options, environment);
  const checks: DoctorCheck[] = [
    platformCheck(platform),
    ...loaded.checks,
    await stateCheck(root, dependencies.currentUid?.() ?? process.getuid?.()),
    await processOwnershipCheck(
      platform,
      runCommand,
      dependencies.readProcessStat ?? (() => readFile("/proc/self/stat", "utf8")),
    ),
    await recoveryMutexCheck(platform, runCommand),
    ...(await gitChecks(loaded.config, runCommand)),
    await dockerCheck(loaded.config.adapters.docker?.enabled === true, runCommand),
    await moleCheck(platform, runCommand),
    await databaseMaintenanceCheck(runCommand),
    ...(await providerChecks(options.home, loaded.config, platform)),
    ...(await artifactChecks(loaded.config)),
    await lockCheck(layout.locks, dependencies.lock),
    await schemaDirectoryCheck("schema:audits", layout.audits, auditReportSchema),
    await schemaDirectoryCheck("schema:plans", layout.plans, cleanupPlanSchema),
    await schemaDirectoryCheck("schema:runs", layout.runs, cleanupRunSchema),
    await schemaDirectoryCheck("schema:quarantine", layout.quarantine, quarantineEntrySchema),
    await schemaDirectoryCheck(
      "schema:provider-quarantine",
      layout.providerQuarantine,
      providerFileQuarantineEntrySchema,
    ),
    await schemaDirectoryCheck(
      "schema:database-backups",
      layout.databaseBackups,
      databaseBackupEntrySchema,
    ),
  ];
  const report = doctorReportSchema.parse({
    schemaVersion: 1,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    status: reportStatus(checks),
    checks,
  });
  return {
    report,
    output: options.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report),
  };
}
