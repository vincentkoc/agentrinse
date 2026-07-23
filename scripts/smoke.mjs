import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "agentrinse-smoke-"));
const home = join(root, "home");
const auditPath = join(root, "audit.json");
const planPath = join(root, "plan.json");

await mkdir(join(home, ".codex", "sessions"), { recursive: true });
await mkdir(join(home, ".local", "share", "opencode", "snapshot"), {
  recursive: true,
});
await writeFile(
  join(home, ".codex", "sessions", "thread.jsonl"),
  "synthetic fixture\n",
);
await writeFile(
  join(home, ".local", "share", "opencode", "snapshot", "object"),
  "synthetic snapshot\n",
);

await execFileAsync(
  process.execPath,
  [
    "dist/cli.js",
    "audit",
    "--home",
    home,
    "--json",
    "--output",
    auditPath,
  ],
  { cwd: process.cwd() },
);
await execFileAsync(
  process.execPath,
  ["dist/cli.js", "plan", "--audit", auditPath, "--output", planPath],
  { cwd: process.cwd() },
);

const audit = JSON.parse(await readFile(auditPath, "utf8"));
const plan = JSON.parse(await readFile(planPath, "utf8"));

if (!Array.isArray(audit.findings) || audit.findings.length !== 2) {
  throw new Error("smoke audit did not find the two synthetic resources");
}

if (!audit.findings.every((finding) => finding.state === "protected")) {
  throw new Error("smoke audit produced a non-protected resource");
}

if (!Array.isArray(plan.actions) || plan.actions.length !== 0) {
  throw new Error("pre-alpha smoke plan must contain zero actions");
}

process.stdout.write(
  `${JSON.stringify({
    syntheticRoot: root,
    findings: audit.findings.length,
    protected: audit.findings.length,
    planActions: plan.actions.length,
  })}\n`,
);
