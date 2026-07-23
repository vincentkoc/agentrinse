import { readFile } from "node:fs/promises";

import { DEFAULT_CONFIG } from "./defaults.js";
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
    plan: {
      ...DEFAULT_CONFIG.plan,
      ...parsed.plan,
    },
  };
}
