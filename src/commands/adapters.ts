import { PROVIDER_SPECS } from "../adapters/provider-specs.js";

export function renderAdapters(): string {
  const lines = [
    "AgentRinse adapters",
    "",
    ...Object.values(PROVIDER_SPECS)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((spec) =>
        spec.id === "codex"
          ? `${spec.id.padEnd(10)} experimental ${spec.displayName} (offline DB vacuum)`
          : `${spec.id.padEnd(10)} audit-only   ${spec.displayName}`,
      ),
    "",
    "git        audit-only  Git worktrees (explicit root)",
    "runtime    audit-only  Installed agent runtimes",
    "docker     audit-only  Docker images, containers, and Buildx cache (opt-in)",
    "artifacts  safe-clean  Explicit rebuildable project directories",
    "",
  ];

  return lines.join("\n");
}
