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
const worktreeConfigPath = join(root, "worktree-config.json");
const worktreeAuditPath = join(root, "worktree-audit.json");
const worktreePlanPath = join(root, "worktree-plan.json");
const worktreeAuditPath2 = join(root, "worktree-audit-2.json");
const worktreePlanPath2 = join(root, "worktree-plan-2.json");
const statePath = join(root, "state");
const project = join(home, "project");
const artifact = join(project, "node_modules");
const worktreeMain = join(home, "worktree-repo");
const worktreeLinked = join(home, "worktree-task");
const worktreeRemote = join(home, "worktree-remote.git");

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

await execFileAsync("git", ["init", "--bare", worktreeRemote]);
await execFileAsync("git", ["init", "-b", "main", worktreeMain]);
await writeFile(join(worktreeMain, "README.md"), "worktree fixture\n");
await execFileAsync("git", ["-C", worktreeMain, "add", "README.md"]);
await execFileAsync("git", [
  "-C",
  worktreeMain,
  "-c",
  "user.name=AgentRinse",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-m",
  "worktree fixture",
]);
await execFileAsync("git", ["-C", worktreeMain, "remote", "add", "origin", worktreeRemote]);
await execFileAsync("git", ["-C", worktreeMain, "push", "-u", "origin", "main"]);
await execFileAsync("git", ["-C", worktreeMain, "branch", "task"]);
await execFileAsync("git", ["-C", worktreeMain, "push", "-u", "origin", "task"]);
await execFileAsync("git", ["-C", worktreeMain, "worktree", "add", worktreeLinked, "task"]);
await writeFile(
  worktreeConfigPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      adapters: {
        codex: { enabled: false },
        claude: { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: false },
        zed: { enabled: false },
        opencode: { enabled: false },
        grok: { enabled: false },
        runtime: { enabled: false },
        git: { enabled: true, root: worktreeMain },
        docker: { enabled: false },
      },
      worktrees: {
        minAgeMinutes: 0,
        quarantineTtlMinutes: 60,
      },
      plan: {
        ttlMinutes: 30,
        maxRisk: "recoverable",
      },
    },
    null,
    2,
  )}\n`,
);

const createWorktreePlan = async (auditOutput, planOutput) => {
  await runCli(["audit", "--home", home, "--config", worktreeConfigPath, "--output", auditOutput]);
  await runCli([
    "plan",
    "--audit",
    auditOutput,
    "--config",
    worktreeConfigPath,
    "--output",
    planOutput,
  ]);
  const worktreeAudit = JSON.parse(await readFile(auditOutput, "utf8"));
  const worktreePlan = JSON.parse(await readFile(planOutput, "utf8"));
  if (
    worktreeAudit.findings?.length !== 2 ||
    worktreeAudit.findings.filter((finding) => finding.state === "eligible").length !== 1 ||
    worktreePlan.actions?.length !== 1 ||
    worktreePlan.actions[0]?.type !== "worktree.quarantine"
  ) {
    throw new Error("smoke worktree audit did not produce one recoverable quarantine action");
  }
};

await createWorktreePlan(worktreeAuditPath, worktreePlanPath);
const worktreeApply = JSON.parse(
  (
    await runCli([
      "apply",
      "--plan",
      worktreePlanPath,
      "--config",
      worktreeConfigPath,
      "--state-dir",
      statePath,
      "--yes",
      "--json",
    ])
  ).stdout,
);
if (
  worktreeApply.status !== "completed" ||
  worktreeApply.actions?.[0]?.type !== "worktree.quarantine" ||
  worktreeApply.actions?.[0]?.status !== "applied" ||
  worktreeApply.reclaimedBytes !== 0 ||
  !(worktreeApply.quarantinedBytes > 0)
) {
  throw new Error("smoke worktree quarantine did not complete with pending bytes");
}
try {
  await access(worktreeLinked);
  throw new Error("smoke quarantine left the original worktree path in place");
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
    throw error;
  }
}

const undo = JSON.parse(
  (
    await runCli([
      "undo",
      worktreeApply.runId,
      "--home",
      home,
      "--config",
      worktreeConfigPath,
      "--state-dir",
      statePath,
      "--yes",
      "--json",
    ])
  ).stdout,
);
if (undo.length !== 1 || undo[0]?.status !== "restored") {
  throw new Error("smoke worktree undo did not restore the quarantine entry");
}
await access(worktreeLinked);

await createWorktreePlan(worktreeAuditPath2, worktreePlanPath2);
const worktreeApply2 = JSON.parse(
  (
    await runCli([
      "apply",
      "--plan",
      worktreePlanPath2,
      "--config",
      worktreeConfigPath,
      "--state-dir",
      statePath,
      "--yes",
      "--json",
    ])
  ).stdout,
);
const purge = JSON.parse(
  (
    await runCli([
      "purge",
      "--run",
      worktreeApply2.runId,
      "--apply",
      "--home",
      home,
      "--config",
      worktreeConfigPath,
      "--state-dir",
      statePath,
      "--yes",
      "--json",
    ])
  ).stdout,
);
if (
  purge.applied !== true ||
  purge.entries?.length !== 1 ||
  purge.entries[0]?.status !== "purged" ||
  !(purge.reclaimedBytes > 0)
) {
  throw new Error("smoke worktree purge did not remove the quarantine entry");
}
const worktreeList = (
  await execFileAsync("git", ["-C", worktreeMain, "worktree", "list", "--porcelain"])
).stdout;
if (worktreeList.includes(worktreeLinked)) {
  throw new Error("smoke purge left the linked worktree registered");
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
    quarantinedBytes: worktreeApply.quarantinedBytes,
    worktreeUndo: undo.length,
    worktreePurgedBytes: purge.reclaimedBytes,
  })}\n`,
);
