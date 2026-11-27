import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { ReachabilityIndex } from "../core/reachability.js";
import { resolvePhysicalPath } from "../core/safety.js";
import { inspectOpenClawDatabase } from "./openclaw-database.js";

import type { AgentRinseConfig } from "../config/schema.js";
import { resolveProviderRoot } from "./provider-root.js";
import { PROVIDER_SPECS } from "./provider-specs.js";

export const OPENCLAW_OWNER = "openclaw-owned-path";
export const OPENCLAW_OWNER_UNKNOWN = "openclaw-ownership-incomplete";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function configPaths(root: string, home: string, environment: NodeJS.ProcessEnv) {
  const paths = new Map<string, "workspace" | "worktreeStorage" | "sessions" | "provider">();
  const workspaces = new Set<string>();
  const path = join(root, "openclaw.json");
  const configured = environment.OPENCLAW_CONFIG_PATH?.trim();
  // External config can include other files and interpolate secrets. Do not
  // evaluate it, expand variables, or scan locations named by the document.
  if (configured && configured !== path) return { complete: false, paths, workspaces };
  try {
    if ((await realpath(path)) !== path) return { complete: false, paths, workspaces };
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 1024 * 1024)
        return { complete: false, paths, workspaces };
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await lstat(path);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.ctimeMs !== after.ctimeMs ||
        bytesRead !== before.size
      )
        return { complete: false, paths, workspaces };
      const config: unknown = JSON.parse(
        bytes.toString("utf8", 0, bytesRead),
        (key, value: unknown) => {
          if (key === "$include") throw new Error("Unresolved include");
          return value;
        },
      );
      if (!object(config)) return { complete: false, paths, workspaces };
      const add = (
        value: unknown,
        surface: "workspace" | "worktreeStorage" | "sessions" | "provider",
      ) => {
        if (value === undefined) return;
        if (typeof value !== "string" || value.includes("\0") || /[${}]/u.test(value))
          throw new Error("Unresolved owner path");
        const expanded = value.startsWith("~/")
          ? join(environment.OPENCLAW_HOME || home, value.slice(2))
          : value;
        if (!isAbsolute(expanded)) throw new Error("Relative owner path");
        const resolved = resolve(expanded);
        paths.set(resolved, surface);
        if (surface === "workspace") workspaces.add(resolved);
      };
      add(config.worktreeRoot, "worktreeStorage");
      if (object(config.session)) add(config.session.store, "sessions");
      if (object(config.agents)) {
        if (object(config.agents.defaults)) add(config.agents.defaults.workspace, "workspace");
        const entries = config.agents.entries;
        const legacy = config.agents.list;
        if (
          (entries !== undefined && !object(entries)) ||
          (legacy !== undefined && !Array.isArray(legacy))
        )
          throw new Error("Unsupported agent roster");
        for (const agent of [...Object.values(entries ?? {}), ...(legacy ?? [])]) {
          if (!object(agent)) throw new Error("Invalid agent entry");
          add(agent.workspace, "workspace");
          add(agent.agentDir, "provider");
        }
      } else if (config.agents !== undefined) throw new Error("Invalid agent roster");
      const engine = object(config.database) ? config.database.engine : undefined;
      return {
        complete:
          config.database === undefined ||
          (object(config.database) && (engine === undefined || engine === "sqlite")),
        paths,
        workspaces,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { complete: false, paths, workspaces };
  }
}

export async function openClawOwnership(
  root: string,
  home: string,
  environment: NodeJS.ProcessEnv,
  maxEntries: number,
  index?: ReachabilityIndex,
) {
  const config = await configPaths(root, home, environment);
  const registry = config.complete
    ? await inspectOpenClawDatabase(join(root, "state", "openclaw.sqlite"), "global", maxEntries)
    : { status: "owner-unresolved" as const };
  if (!index) return { config, registry };
  const paths = new Set([root, ...config.paths.keys()]);
  if (registry.status === "observed") {
    for (const record of registry.worktrees) {
      paths.add(record.path);
      paths.add(record.repoRoot);
    }
  }
  let complete = config.complete && registry.status === "observed" && !registry.truncated;
  for (const path of paths) {
    const evidence = {
      path,
      code: OPENCLAW_OWNER,
      source: "openclaw",
      detail:
        "OpenClaw owns this profile, configured path, source repository or registered checkout.",
    };
    index.add(evidence);
    try {
      index.add({ ...evidence, path: await resolvePhysicalPath(path) });
    } catch {
      complete = false;
    }
  }
  if (!complete) {
    index.addGlobal({
      code: OPENCLAW_OWNER_UNKNOWN,
      source: "openclaw",
      detail: "OpenClaw's configured roots and worktree registry could not be fully verified.",
    });
  }
  return { config, registry };
}

export async function openClawPathProtection(
  home: string,
  config: AgentRinseConfig,
  targets: readonly string[],
  now: Date,
): Promise<string | undefined> {
  const configured = config.adapters.openclaw;
  try {
    const root = resolveProviderRoot(PROVIDER_SPECS.openclaw, home, {
      environment: process.env,
      ...(configured?.root === undefined ? {} : { root: configured.root }),
    });
    const stats = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) return undefined;
    if (!stats.isDirectory()) return "The OpenClaw profile is not a real directory.";
    const index = new ReachabilityIndex();
    await openClawOwnership(
      await realpath(root),
      home,
      process.env,
      config.audit.maxEntries,
      index,
    );
    return targets.flatMap((path) => index.rootsFor(path, now.toISOString()))[0]?.detail;
  } catch {
    return "OpenClaw ownership could not be verified.";
  }
}
