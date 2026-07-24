import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-package-smoke-")));
const packageRoot = join(root, "package");
const installRoot = join(root, "install");
const requestedTarball = process.argv.slice(2).find((argument) => argument !== "--");

let tarball;
if (requestedTarball) {
  tarball = resolve(requestedTarball);
} else {
  await mkdir(packageRoot);
  const packed = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packageRoot], {
    cwd: process.cwd(),
  });
  const result = JSON.parse(packed.stdout);
  const filename = result[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report a package filename");
  }
  tarball = join(packageRoot, filename);
}

await readFile(tarball);
await execFileAsync(
  "npm",
  ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
  { cwd: root },
);

const executable =
  process.platform === "win32"
    ? join(installRoot, "node_modules", ".bin", "agentrinse.cmd")
    : join(installRoot, "node_modules", ".bin", "agentrinse");
const version = (await execFileAsync(executable, ["--version"], { cwd: root })).stdout.trim();
const smoke = await execFileAsync(process.execPath, ["scripts/smoke.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGENTRINSE_SMOKE_CLI: executable,
  },
});
const result = JSON.parse(smoke.stdout);

process.stdout.write(
  `${JSON.stringify({
    ...result,
    version,
    package: basename(tarball),
    installed: true,
  })}\n`,
);
