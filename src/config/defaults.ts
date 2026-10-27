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
    runtime: { enabled: false },
    git: { enabled: false },
    docker: { enabled: false },
  },
  audit: {
    maxEntries: 100_000,
    measureBytes: true,
    gitTimeoutMs: 10_000,
    processOwnershipTimeoutMs: 10_000,
    deadlineMs: 180_000,
    phaseTimeoutMs: 30_000,
  },
  artifacts: {
    projects: [],
    minAgeMinutes: 24 * 60,
    minBytes: 64 * 1024 * 1024,
    processCheck: "required",
  },
  worktrees: {
    minAgeMinutes: 14 * 24 * 60,
    quarantineTtlMinutes: 7 * 24 * 60,
  },
  pins: [],
  plan: {
    ttlMinutes: 30,
    maxRisk: "safe",
  },
};
