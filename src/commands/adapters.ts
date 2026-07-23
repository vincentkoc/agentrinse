import { PROVIDER_SPECS } from "../adapters/provider-specs.js";

export function renderAdapters(): string {
  const lines = [
    "AgentRinse adapters",
    "",
    ...Object.values(PROVIDER_SPECS)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((spec) => `${spec.id.padEnd(10)} audit-only  ${spec.displayName}`),
    "",
    "git        planned     Git worktrees",
    "docker     planned     Docker resources",
    "",
  ];

  return lines.join("\n");
}
