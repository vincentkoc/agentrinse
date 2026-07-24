import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  cleanCommandExitCode,
  cleanCommandStatus,
  executeCleanCommand,
} from "../../src/commands/clean.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { commandEnvelopeSchema } from "../../src/contracts/output.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-07-24T12:00:00.000Z");

async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, { encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function gitFixture(): Promise<{
  home: string;
  main: string;
  linked: string;
  configPath: string;
  stateDir: string;
}> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-clean-")));
  const main = join(home, "repo");
  const linked = join(home, "task");
  const configPath = join(home, "config.json");
  const stateDir = join(home, "state");
  await run("git", ["init", "-b", "main", main]);
  await writeFile(join(main, "README.md"), "fixture\n");
  await run("git", ["-C", main, "add", "README.md"]);
  await run("git", [
    "-C",
    main,
    "-c",
    "user.name=AgentRinse",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await run("git", ["-C", main, "worktree", "add", "-b", "task", linked]);
  return { home, main, linked, configPath, stateDir };
}

function fixtureConfig(projects: { root: string; names: ["node_modules"] }[]) {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    adapters: {
      ...structuredClone(DEFAULT_CONFIG.adapters),
      codex: { enabled: false },
      claude: { enabled: false },
    },
    audit: {
      maxEntries: 100,
      measureBytes: true,
    },
    artifacts: {
      projects,
      minAgeMinutes: 0,
      minBytes: 0,
      processCheck: "required" as const,
    },
  };
}

describe("clean closeout profile", () => {
  it("returns a nonzero automation status for degraded safety evidence", () => {
    expect(cleanCommandExitCode({ status: "degraded" })).toBe(1);
    expect(cleanCommandExitCode({ status: "ok" })).toBeUndefined();
    expect(cleanCommandStatus({ probes: [], diagnostics: [] }, { status: "interrupted" })).toBe(
      "failed",
    );
  });

  it("scopes a compact dry run to one repository and protects the current worktree", async () => {
    const value = await gitFixture();
    const currentArtifact = join(value.linked, "node_modules");
    const unrelated = join(value.home, "unrelated");
    await mkdir(currentArtifact);
    await mkdir(join(unrelated, "node_modules"), { recursive: true });
    await writeFile(join(currentArtifact, "cache.bin"), "current");
    await writeFile(join(unrelated, "node_modules", "cache.bin"), "unrelated");
    await writeJsonAtomic(
      value.configPath,
      fixtureConfig([
        { root: value.linked, names: ["node_modules"] },
        { root: unrelated, names: ["node_modules"] },
      ]),
    );

    const result = await executeCleanCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateDir,
      profile: "closeout",
      cwd: value.linked,
      apply: false,
      yes: false,
      json: true,
      dependencies: {
        platform: "darwin",
        now: () => NOW,
        runCommand: async (command, args) =>
          command === "mo" ? { stdout: "Mole fixture\n", stderr: "" } : run(command, args),
      },
    });
    const envelope = commandEnvelopeSchema.parse(JSON.parse(result.output));
    const artifactFindings = result.audit.findings.filter(
      (finding) => finding.resource.kind === "build-artifact",
    );

    expect(result.summary.repositoryRoot).toBe(value.main);
    expect(result.summary.currentWorktree).toBe(value.linked);
    expect(result.summary.worktrees).toBe(2);
    expect(result.summary.protectedWorktrees).toBe(2);
    expect(result.summary.eligibleActions).toBe(0);
    expect(result.summary.mole).toEqual({
      status: "available",
      suggestions: ["mo purge --dry-run", "mo clean --dry-run"],
    });
    expect(artifactFindings).toHaveLength(1);
    expect(artifactFindings[0]?.state).toBe("protected");
    expect(artifactFindings[0]?.roots.map((root) => root.code)).toContain("current-worktree");
    expect(result.audit.probes.map((probe) => probe.adapter)).not.toContain("cursor");
    expect(envelope.command).toBe("clean");
    expect(result.status).toBe("ok");
    await Promise.all([
      access(result.summary.auditPath),
      access(result.summary.planPath),
      access(result.summary.configPath),
    ]);
    const scopedConfig = JSON.parse(await readFile(result.summary.configPath, "utf8"));
    expect(scopedConfig.artifacts.projects).toEqual([
      { root: value.linked, names: ["node_modules"] },
    ]);
  });

  it("marks incomplete provider reachability as degraded", async () => {
    const value = await gitFixture();
    const codexRoot = join(value.home, ".codex");
    await mkdir(codexRoot);
    const config = fixtureConfig([]);
    config.adapters.codex = { enabled: true };
    await writeJsonAtomic(value.configPath, config);

    const result = await executeCleanCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateDir,
      profile: "closeout",
      cwd: value.linked,
      apply: false,
      yes: false,
      json: true,
      dependencies: {
        platform: "linux",
        now: () => NOW,
        runCommand: run,
      },
    });
    const envelope = commandEnvelopeSchema.parse(JSON.parse(result.output));

    expect(result.status).toBe("degraded");
    expect(cleanCommandExitCode(result)).toBe(1);
    expect(envelope.status).toBe("degraded");
    expect(result.audit.diagnostics.map((item) => item.code)).toContain(
      "CODEX_WORKSPACE_METADATA_MISSING",
    );
  });

  it("applies only an existing safe artifact action from a fresh closeout plan", async () => {
    const value = await gitFixture();
    const artifact = join(value.main, "node_modules");
    const artifactFile = join(artifact, "cache.bin");
    await mkdir(artifact);
    await writeFile(artifactFile, "remove");
    await utimes(artifactFile, new Date(0), new Date(0));
    await utimes(artifact, new Date(0), new Date(0));
    await writeJsonAtomic(
      value.configPath,
      fixtureConfig([{ root: value.main, names: ["node_modules"] }]),
    );

    const result = await executeCleanCommand({
      home: value.home,
      config: value.configPath,
      stateDir: value.stateDir,
      profile: "closeout",
      cwd: value.linked,
      apply: true,
      yes: true,
      json: false,
      dependencies: {
        platform: "linux",
        now: () => NOW,
        runCommand: run,
      },
    });

    expect(result.plan.actions).toHaveLength(1);
    expect(result.run?.status).toBe("completed");
    expect(result.run?.actions[0]?.status).toBe("applied");
    await expect(access(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(value.main, "README.md"), "utf8")).resolves.toBe("fixture\n");
  });
});
