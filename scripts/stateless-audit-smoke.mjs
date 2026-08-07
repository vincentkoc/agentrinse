import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = await realpath(
  dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
);
const dependenciesRoot = await realpath(join(repositoryRoot, "node_modules"));
const cli = join(repositoryRoot, "dist", "cli.js");
const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-stateless-smoke-")));
const home = join(fixtureRoot, "home");
const trapBin = join(fixtureRoot, "trap-bin");
const trapMarker = join(fixtureRoot, "trap-invocations.log");
const stateRoot = join(home, "forbidden-state");
const configPath = join(home, "config.json");
const cursorRoot = join(home, "selected", "cursor");
const copilotRoot = join(home, "selected", "copilot");
const opencodeRoot = join(home, "selected", "opencode");
const artifactRoot = join(home, "project");

async function expectMissing(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} was created`);
}

async function snapshotTree(root) {
  const entries = [];
  const visit = async (path) => {
    const stats = await lstat(path, { bigint: true });
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({
      path: relative(root, path) || ".",
      kind,
      mode: stats.mode.toString(),
      size: stats.size.toString(),
      modified: stats.mtimeNs.toString(),
      changed: stats.ctimeNs.toString(),
      created: stats.birthtimeNs.toString(),
      inode: stats.ino.toString(),
      uid: stats.uid.toString(),
      gid: stats.gid.toString(),
      ...(kind === "file"
        ? {
            content: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          }
        : {}),
    });
    if (kind === "directory") {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name));
      }
    }
  };
  await visit(root);
  return entries;
}

await mkdir(trapBin, { recursive: true });
for (const binary of ["mo", "grok", "codex", "git", "docker", "sqlite3", "lsof"]) {
  const path = join(trapBin, process.platform === "win32" ? `${binary}.cmd` : binary);
  await writeFile(
    path,
    process.platform === "win32"
      ? `@echo ${binary}>>"%TRAP_MARKER%"\r\n@exit /b 97\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${binary}' >> "$TRAP_MARKER"\nexit 97\n`,
  );
  if (process.platform !== "win32") {
    await chmod(path, 0o755);
  }
}

await mkdir(join(cursorRoot, "User", "workspaceStorage", "workspace"), {
  recursive: true,
});
await mkdir(join(cursorRoot, "User", "globalStorage"), { recursive: true });
await mkdir(join(cursorRoot, "logs"), { recursive: true });
await writeFile(join(cursorRoot, "User", "workspaceStorage", "workspace", "state.json"), "{}");
await writeFile(join(cursorRoot, "User", "globalStorage", "state.vscdb"), "cursor");
await mkdir(join(copilotRoot, "session-state"), { recursive: true });
await mkdir(join(copilotRoot, "logs"), { recursive: true });
await writeFile(join(copilotRoot, "session-state", "session.json"), "{}");
await mkdir(join(opencodeRoot, "log"), { recursive: true });
await mkdir(join(opencodeRoot, "snapshot"), { recursive: true });
await writeFile(join(opencodeRoot, "opencode.db"), "opencode");
await writeFile(join(opencodeRoot, "snapshot", "object"), "snapshot");

await mkdir(join(home, "excluded-codex", "sessions"), { recursive: true });
await writeFile(join(home, "excluded-codex", "sessions", "thread.jsonl"), "keep");
await mkdir(join(home, "excluded-grok", "logs"), { recursive: true });
await writeFile(join(home, "excluded-grok", "logs", "grok.log"), "keep");
await mkdir(join(artifactRoot, "node_modules"), { recursive: true });
await writeFile(join(artifactRoot, "node_modules", "cache"), "keep");
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      adapters: {
        codex: { enabled: true, root: join(home, "excluded-codex") },
        claude: { enabled: true, root: join(home, "excluded-claude") },
        cursor: { enabled: true, root: cursorRoot },
        copilot: { enabled: true, root: copilotRoot },
        zed: { enabled: true, root: join(home, "excluded-zed") },
        opencode: { enabled: true, root: opencodeRoot },
        grok: { enabled: true, root: join(home, "excluded-grok") },
        runtime: { enabled: true },
        git: { enabled: true, root: artifactRoot },
        docker: { enabled: true },
      },
      audit: {
        maxEntries: 1000,
        measureBytes: false,
      },
      artifacts: {
        projects: [{ root: artifactRoot, names: ["node_modules"] }],
        minAgeMinutes: 0,
        minBytes: 0,
        processCheck: "required",
      },
    },
    null,
    2,
  )}\n`,
);

const before = await snapshotTree(home);
const permissionFlags = process.allowedNodeEnvironmentFlags;
const runtimeDenied = ["fs-write", "child-process", "addons"];
const externalSandboxRequired = [];
if (permissionFlags.has("--allow-net")) {
  runtimeDenied.push("net");
} else {
  externalSandboxRequired.push("net");
}
if (permissionFlags.has("--allow-ffi")) {
  runtimeDenied.push("ffi");
} else {
  externalSandboxRequired.push("ffi");
}
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_STATE_HOME: stateRoot,
  PATH: `${trapBin}${delimiter}${process.env.PATH ?? ""}`,
  TRAP_MARKER: trapMarker,
};
for (const name of [
  "BUILDX_BUILDER",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "DOCKER_HOST",
  "FLATPAK_XDG_DATA_HOME",
  "GROK_HOME",
  "NODE_OPTIONS",
  "XDG_DATA_HOME",
]) {
  delete environment[name];
}

const permissionArguments = [
  "--permission",
  `--allow-fs-read=${repositoryRoot}`,
  `--allow-fs-read=${dependenciesRoot}`,
  `--allow-fs-read=${fixtureRoot}`,
  cli,
  "audit",
  "--home",
  home,
  "--config",
  configPath,
  "--providers",
  "cursor,copilot,opencode",
  "--no-state",
  "--json",
];
const completed = await execFileAsync(process.execPath, permissionArguments, {
  cwd: fixtureRoot,
  env: environment,
  maxBuffer: 16 * 1024 * 1024,
});
if (completed.stderr !== "") {
  throw new Error(`stateless audit wrote stderr: ${completed.stderr}`);
}

const envelope = JSON.parse(completed.stdout);
const probes = envelope.data?.probes?.map((probe) => probe.adapter);
if (JSON.stringify(probes) !== JSON.stringify(["copilot", "cursor", "opencode"])) {
  throw new Error(`stateless audit probed unexpected adapters: ${JSON.stringify(probes)}`);
}
const findingAdapters = new Set(
  envelope.data?.findings?.map((finding) => finding.resource?.adapter),
);
if (
  findingAdapters.size !== 3 ||
  !["copilot", "cursor", "opencode"].every((provider) => findingAdapters.has(provider))
) {
  throw new Error("stateless audit returned findings outside the selected providers");
}
for (const excluded of ["excluded-codex", "excluded-grok", "node_modules"]) {
  if (completed.stdout.includes(excluded)) {
    throw new Error(`stateless audit exposed excluded root: ${excluded}`);
  }
}

const after = await snapshotTree(home);
if (JSON.stringify(after) !== JSON.stringify(before)) {
  throw new Error("stateless audit changed synthetic HOME metadata or content");
}
await expectMissing(stateRoot, "AgentRinse state");
await expectMissing(trapMarker, "trap invocation log");

process.stdout.write(
  `${JSON.stringify({
    statelessAudit: true,
    providers: probes,
    runtimeDenied,
    externalSandboxRequired,
    trapBinaries: ["mo", "grok", "codex", "git", "docker", "sqlite3", "lsof"],
  })}\n`,
);
