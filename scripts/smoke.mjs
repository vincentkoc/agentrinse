import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const { assertDestructiveFixtureRoot } = await import("../dist/core/safety.js");
const installedCli = process.env.AGENTRINSE_SMOKE_CLI;
const sourceCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const runCli = (args, cwd = process.cwd()) =>
  installedCli
    ? execFileAsync(installedCli, args, { cwd })
    : execFileAsync(process.execPath, [sourceCli, ...args], { cwd });
const root = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-smoke-")));
await assertDestructiveFixtureRoot(root);
const home = join(root, "home");
const auditPath = join(root, "audit.json");
const planPath = join(root, "plan.json");
const configPath = join(root, "config.json");
const statePath = join(root, "state");
const project = join(home, "project");
const artifact = join(project, "node_modules");

await mkdir(join(home, ".codex", "sessions"), { recursive: true });
await mkdir(join(home, ".local", "share", "opencode", "snapshot"), {
  recursive: true,
});
await writeFile(join(home, ".codex", "sessions", "thread.jsonl"), "synthetic fixture\n");
await writeFile(
  join(home, ".codex", ".codex-global-state.json"),
  `${JSON.stringify({
    "active-workspace-roots": [],
    "electron-saved-workspace-roots": [],
    "thread-workspace-root-hints": {},
  })}\n`,
);
await writeFile(
  join(home, ".local", "share", "opencode", "snapshot", "object"),
  "synthetic snapshot\n",
);
await mkdir(artifact, { recursive: true });
await writeFile(join(project, "source.ts"), "keep\n");
await writeFile(join(artifact, "cache.bin"), "remove\n");
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      artifacts: {
        projects: [{ root: project, names: ["node_modules"] }],
        minAgeMinutes: 0,
        minBytes: 0,
        processCheck: "required",
      },
    },
    null,
    2,
  )}\n`,
);

await runCli(["audit", "--home", home, "--config", configPath, "--json", "--output", auditPath]);
await runCli(["plan", "--audit", auditPath, "--config", configPath, "--output", planPath]);

const audit = JSON.parse(await readFile(auditPath, "utf8"));
const plan = JSON.parse(await readFile(planPath, "utf8"));

if (!Array.isArray(audit.findings) || audit.findings.length !== 3) {
  throw new Error("smoke audit did not find all synthetic resources");
}

if (
  audit.findings.filter((finding) => finding.state === "protected").length !== 2 ||
  audit.findings.filter((finding) => finding.state === "eligible").length !== 1
) {
  throw new Error("smoke audit classifications are incorrect");
}

if (!Array.isArray(plan.actions) || plan.actions.length !== 1) {
  throw new Error("smoke plan must contain one artifact action");
}

await access(artifact);
const apply = await runCli([
  "apply",
  "--plan",
  planPath,
  "--config",
  configPath,
  "--state-dir",
  statePath,
  "--yes",
  "--json",
]);
const run = JSON.parse(apply.stdout);

if (run.status !== "completed" || run.actions?.[0]?.status !== "applied") {
  throw new Error("smoke apply did not complete");
}
await access(join(project, "source.ts"));
try {
  await access(artifact);
  throw new Error("smoke apply left the planned artifact in place");
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

await execFileAsync("git", ["init", "-b", "main"], { cwd: project });
await execFileAsync("git", ["add", "source.ts"], { cwd: project });
await execFileAsync(
  "git",
  [
    "-c",
    "user.name=AgentRinse",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ],
  { cwd: project },
);
const closeoutOutput = await runCli(
  [
    "clean",
    "--profile",
    "closeout",
    "--home",
    home,
    "--config",
    configPath,
    "--state-dir",
    statePath,
    "--json",
  ],
  project,
);
const closeout = JSON.parse(closeoutOutput.stdout);
if (
  closeout.command !== "clean" ||
  closeout.data?.profile !== "closeout" ||
  closeout.data?.worktrees !== 1 ||
  closeout.data?.eligibleActions !== 0
) {
  throw new Error("smoke closeout profile did not produce the expected bounded summary");
}
process.stdout.write(
  `${JSON.stringify({
    version: packageJson.version,
    syntheticRoot: root,
    findings: audit.findings.length,
    protected: 2,
    planActions: plan.actions.length,
    applied: 1,
    closeoutWorktrees: closeout.data.worktrees,
    reclaimedBytes: run.reclaimedBytes,
  })}\n`,
);
