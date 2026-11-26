import { classifyOwnership } from "./native-maintenance.js";
import { homePath, type ProviderSpec } from "../provider.js";

export const grokRuleset: ProviderSpec = {
  id: "grok",
  displayName: "Grok Build",
  defaultRoot: homePath(".grok"),
  resources: [
    {
      relativePath: "sessions",
      displayName: "Grok Build sessions",
      kind: "agent-session-store",
    },
    {
      relativePath: "logs",
      displayName: "Grok Build logs",
      kind: "agent-log-store",
    },
    {
      relativePath: "memory",
      displayName: "Grok Build memory",
      kind: "agent-home",
    },
    {
      relativePath: "worktrees",
      displayName: "Grok Build managed worktrees",
      kind: "git-worktree",
    },
    {
      relativePath: "marketplace-cache",
      displayName: "Grok Build marketplace cache",
      kind: "agent-cache",
    },
    {
      relativePath: "downloads",
      displayName: "Grok Build downloaded runtimes",
      kind: "agent-runtime",
    },
  ],
  environmentRoot: "GROK_HOME",
  classify: classifyOwnership,
};
