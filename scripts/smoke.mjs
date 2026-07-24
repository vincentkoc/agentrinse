import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const { assertDestructiveFixtureRoot } = await import("../dist/core/safety.js");
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

await execFileAsync(
  process.execPath,
  ["dist/cli.js", "audit", "--home", home, "--config", configPath, "--json", "--output", auditPath],
  { cwd: process.cwd() },
);
await execFileAsync(
  process.execPath,
  ["dist/cli.js", "plan", "--audit", auditPath, "--config", configPath, "--output", planPath],
  { cwd: process.cwd() },
);

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
const apply = await execFileAsync(
  process.execPath,
  [
    "dist/cli.js",
    "apply",
    "--plan",
    planPath,
    "--config",
    configPath,
    "--state-dir",
    statePath,
    "--yes",
    "--json",
  ],
  { cwd: process.cwd() },
);
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
process.stdout.write(
  `${JSON.stringify({
    version: packageJson.version,
    syntheticRoot: root,
    findings: audit.findings.length,
    protected: 2,
    planActions: plan.actions.length,
    applied: 1,
    reclaimedBytes: run.reclaimedBytes,
  })}\n`,
);
