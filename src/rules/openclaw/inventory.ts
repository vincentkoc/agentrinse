import { openClawProtection } from "./storage.js";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import { homePath, type ProviderSpec } from "../provider.js";

export const openclawRuleset: ProviderSpec = {
  id: "openclaw",
  displayName: "OpenClaw",
  defaultRoot: homePath(".openclaw"),
  resources: [
    {
      relativePath: "agents",
      displayName: "OpenClaw per-agent state",
      kind: "agent-session-store",
    },
    { relativePath: "state", displayName: "OpenClaw shared state", kind: "agent-home" },
    { relativePath: "workspace", displayName: "OpenClaw workspace", kind: "agent-home" },
    { relativePath: "logs", displayName: "OpenClaw logs", kind: "agent-log-store" },
    {
      relativePath: "worktrees",
      displayName: "OpenClaw worktree storage",
      kind: "agent-snapshot-store",
    },
    { relativePath: "cache", displayName: "OpenClaw cache", kind: "agent-cache" },
    { relativePath: "credentials", displayName: "OpenClaw credentials", kind: "agent-home" },
    { relativePath: "client", displayName: "OpenClaw client state", kind: "agent-home" },
    { relativePath: "memory", displayName: "OpenClaw memory", kind: "agent-home" },
    { relativePath: "media", displayName: "OpenClaw media", kind: "agent-home" },
  ],
  classify(context, resource) {
    const protection = openClawProtection(resource);
    return protection
      ? reportOnlyFinding(context, resource, "openclaw", "certain", [protection])
      : undefined;
  },
};
