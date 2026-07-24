import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const packagePath = join(root, "package.json");
const source = await readFile(packagePath, "utf8");
const packageJson = JSON.parse(source);

if (packageJson.bin?.agentrinse !== "dist/cli.js") {
  throw new Error('package.json bin.agentrinse must be "dist/cli.js"');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "agentrinse-package-manifest-"));

try {
  await writeFile(join(temporaryRoot, "package.json"), source);
  await cp(join(root, "dist"), join(temporaryRoot, "dist"), { recursive: true });
  if (process.platform === "win32") {
    await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm pkg fix"], {
      cwd: temporaryRoot,
    });
  } else {
    await execFileAsync("npm", ["pkg", "fix"], { cwd: temporaryRoot });
  }

  const normalized = await readFile(join(temporaryRoot, "package.json"), "utf8");
  if (normalized !== source) {
    throw new Error("npm pkg fix would rewrite package.json");
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write("verified npm package manifest\n");
