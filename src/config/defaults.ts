import type { AgentRinseConfig } from "./schema.js";

export const DEFAULT_CONFIG: AgentRinseConfig = {
  schemaVersion: 1,
  adapters: {
    codex: { enabled: true },
    claude: { enabled: true },
    cursor: { enabled: true },
    copilot: { enabled: true },
    zed: { enabled: true },
    opencode: { enabled: true },
    grok: { enabled: true },
    git: { enabled: false },
    docker: { enabled: false },
  },
  audit: {
    maxEntries: 100_000,
    measureBytes: true,
  },
  plan: {
    ttlMinutes: 30,
    maxRisk: "safe",
  },
};
