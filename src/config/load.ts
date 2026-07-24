import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_CONFIG } from "./defaults.js";
import { resolveConfigPath, type ConfigEnvironment } from "./path.js";
import { agentRinseConfigSchema, type AgentRinseConfig } from "./schema.js";

export async function loadConfig(path?: string): Promise<AgentRinseConfig> {
  if (path === undefined) {
    return structuredClone(DEFAULT_CONFIG);
  }

  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = agentRinseConfigSchema.parse(input);

  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...parsed,
    adapters: {
      ...structuredClone(DEFAULT_CONFIG.adapters),
      ...parsed.adapters,
    },
    audit: {
      ...DEFAULT_CONFIG.audit,
      ...parsed.audit,
    },
    artifacts: {
      ...DEFAULT_CONFIG.artifacts,
      ...parsed.artifacts,
    },
    plan: {
      ...DEFAULT_CONFIG.plan,
      ...parsed.plan,
    },
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function loadConfigForHome(
  home: string,
  explicitPath?: string,
  environment: ConfigEnvironment = process.env,
): Promise<{ config: AgentRinseConfig; path: string; exists: boolean }> {
  const path = resolveConfigPath(resolve(home), explicitPath, environment);
  try {
    return {
      config: await loadConfig(path),
      path,
      exists: true,
    };
  } catch (error) {
    if (explicitPath === undefined && isMissing(error)) {
      return {
        config: await loadConfig(),
        path,
        exists: false,
      };
    }
    throw error;
  }
}
