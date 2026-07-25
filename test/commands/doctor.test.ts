import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeDoctorCommand, type CommandResult } from "../../src/commands/doctor.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";
import { stateLayout } from "../../src/state/layout.js";
import type { ApplyLockOwner } from "../../src/state/lock.js";

function commandError(message: string, code = "ENOENT"): Error {
  return Object.assign(new Error(message), { code });
}

function healthyRunner(command: string, args: string[]): Promise<CommandResult> {
  const key = `${command} ${args.join(" ")}`;
  const output: Record<string, string> = {
    "lsof -v": "lsof 4.99",
    "sqlite3 --version": "3.51.0",
    "git --version": "git version 2.50.1",
    "docker --version": "Docker version 28.3.0",
    "docker context show": "desktop-linux",
    "docker version --format {{.Server.Version}}": "28.3.0",
    "mo --version": "Mole 1.17.0",
    "sh -c command -v lockf": "/usr/bin/lockf",
    "sh -c command -v flock": "/usr/bin/flock",
  };
  const stdout = output[key];
  return stdout === undefined
    ? Promise.reject(commandError(`unexpected command: ${key}`))
    : Promise.resolve({ stdout: `${stdout}\n`, stderr: "" });
}

async function setup(): Promise<{
  home: string;
  configPath: string;
  stateRoot: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-doctor-"));
  const configPath = join(home, "config.json");
  const stateRoot = join(home, "state", "agentrinse");
  await writeJsonAtomic(configPath, DEFAULT_CONFIG);
  return { home, configPath, stateRoot };
}

describe("doctor command", () => {
  it("reports a healthy synthetic environment without mutation", async () => {
    const value = await setup();
    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        now: () => new Date("2026-07-24T00:00:00.000Z"),
        runCommand: healthyRunner,
      },
    });

    expect(result.report.status).toBe("ok");
    expect(result.output).toContain("AgentRinse doctor: ok");
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "process-ownership", status: "pass" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "recovery-mutex", status: "pass" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "docker", status: "pass" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "database-maintenance", status: "pass" }),
    );
  });

  it("isolates invalid config, Docker failure, stale lock, and schema drift", async () => {
    const value = await setup();
    await writeFile(value.configPath, '{"schemaVersion":2}\n');
    const layout = stateLayout(value.stateRoot);
    await mkdir(layout.locks, { recursive: true });
    const owner: ApplyLockOwner = {
      token: "fixture-token",
      pid: 42,
      processStartIdentity: "fixture-start",
      hostname: "fixture-host",
      command: "agentrinse apply",
      planId: "plan-1",
      runId: "run-1",
      createdAt: "2026-07-23T00:00:00.000Z",
    };
    await writeFile(join(layout.locks, "apply.lock"), `${JSON.stringify(owner)}\n`);
    await mkdir(layout.runs, { recursive: true });
    await writeFile(join(layout.runs, "broken.json"), '{"schemaVersion":99}\n');

    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: true,
      dependencies: {
        platform: "darwin",
        runCommand: async (command, args) => {
          if (command === "docker") {
            throw commandError("daemon unavailable", "ECONNREFUSED");
          }
          return healthyRunner(command, args);
        },
        lock: {
          currentHostname: () => "fixture-host",
          inspectProcess: async () => ({ status: "dead" }),
        },
      },
    });

    expect(result.report.status).toBe("error");
    expect(JSON.parse(result.output)).toEqual(result.report);
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "config", status: "error" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "docker", status: "pass" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "apply-lock", status: "warning" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "schema:runs", status: "error" }),
    );
  });

  it("flags missing lsof and Git while treating optional tools as isolated", async () => {
    const value = await setup();
    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        runCommand: async (command) => {
          throw commandError(`${command} unavailable`);
        },
      },
    });

    expect(result.report.status).toBe("error");
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "process-ownership", status: "error" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "git", status: "error" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "recovery-mutex", status: "error" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "docker", status: "pass" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "mole", status: "pass" }),
    );
  });

  it("passes when an installed Docker CLI has no daemon and its adapter is disabled", async () => {
    const value = await setup();
    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        runCommand: async (command, args) => {
          if (command === "docker" && args[0] !== "--version") {
            throw commandError("daemon unavailable", "ECONNREFUSED");
          }
          return healthyRunner(command, args);
        },
      },
    });

    expect(result.report.checks).toContainEqual(
      expect.objectContaining({
        id: "docker",
        status: "pass",
        summary: "Docker daemon is unavailable (optional)",
      }),
    );
  });

  it("reports lock inspection failures instead of aborting doctor", async () => {
    const value = await setup();
    const layout = stateLayout(value.stateRoot);
    await mkdir(layout.locks, { recursive: true });
    const owner: ApplyLockOwner = {
      token: "fixture-token",
      pid: 42,
      processStartIdentity: "fixture-start",
      hostname: "fixture-host",
      command: "agentrinse apply",
      planId: "plan-1",
      runId: "run-1",
      createdAt: "2026-07-23T00:00:00.000Z",
    };
    await writeFile(join(layout.locks, "apply.lock"), `${JSON.stringify(owner)}\n`);

    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        runCommand: healthyRunner,
        lock: {
          currentHostname: () => "fixture-host",
          inspectProcess: async () => {
            throw commandError("permission denied", "EACCES");
          },
        },
      },
    });

    expect(result.report.status).toBe("error");
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({
        id: "apply-lock",
        status: "error",
        summary: "apply lock could not be inspected",
        detail: "permission denied",
      }),
    );
  });

  it("uses lsof when Linux procfs ownership proof is unavailable", async () => {
    const value = await setup();
    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "linux",
        runCommand: healthyRunner,
        readProcessStat: async () => {
          throw commandError("procfs unavailable", "EACCES");
        },
      },
    });

    expect(result.report.checks).toContainEqual(
      expect.objectContaining({
        id: "process-ownership",
        status: "pass",
        summary: "lsof fallback ownership proof is available",
      }),
    );
  });

  it("rejects directories without search permission", async () => {
    const value = await setup();
    const project = join(value.home, "project");
    await mkdir(value.stateRoot, { recursive: true });
    await mkdir(project);
    await chmod(value.stateRoot, 0o600);
    await chmod(project, 0o600);
    await writeJsonAtomic(value.configPath, {
      ...structuredClone(DEFAULT_CONFIG),
      artifacts: {
        projects: [{ root: project, names: ["node_modules"] }],
      },
    });

    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        runCommand: healthyRunner,
      },
    });

    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "state", status: "error" }),
    );
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "artifact-root:0", status: "error" }),
    );
  });

  it("rejects an existing state root owned by another UID", async () => {
    const value = await setup();
    await mkdir(value.stateRoot, { recursive: true });
    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        runCommand: healthyRunner,
        currentUid: () => Number.MAX_SAFE_INTEGER,
      },
    });

    expect(result.report.checks).toContainEqual(
      expect.objectContaining({
        id: "state",
        status: "error",
        summary: "state directory is not owned by the current user",
      }),
    );
  });

  it("proves Git worktree porcelain when the adapter is enabled", async () => {
    const value = await setup();
    await writeJsonAtomic(value.configPath, {
      ...structuredClone(DEFAULT_CONFIG),
      adapters: {
        ...structuredClone(DEFAULT_CONFIG.adapters),
        git: { enabled: true, root: value.home },
      },
    });
    const result = await executeDoctorCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateRoot,
      json: false,
      dependencies: {
        platform: "darwin",
        runCommand: async (command, args) => {
          if (command === "git" && args.includes("worktree")) {
            return { stdout: `worktree ${value.home}\0`, stderr: "" };
          }
          return healthyRunner(command, args);
        },
      },
    });

    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ id: "git:porcelain", status: "pass" }),
    );
  });
});
