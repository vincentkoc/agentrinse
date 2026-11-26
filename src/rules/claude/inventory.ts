import { classifyOwnership } from "./native-maintenance.js";
import { homePath, type ProviderSpec } from "../provider.js";

export const claudeRuleset: ProviderSpec = {
  id: "claude",
  displayName: "Claude Code",
  defaultRoot: homePath(".claude"),
  resources: [
    {
      relativePath: "projects",
      displayName: "Claude project sessions",
      kind: "agent-session-store",
    },
    {
      relativePath: "debug",
      displayName: "Claude debug logs",
      kind: "agent-log-store",
    },
    {
      relativePath: "worktrees",
      displayName: "Claude managed worktrees",
      kind: "git-worktree",
    },
    {
      relativePath: "paste-cache",
      displayName: "Claude paste cache",
      kind: "agent-cache",
    },
    {
      relativePath: "image-cache",
      displayName: "Claude image cache",
      kind: "agent-cache",
    },
  ],
  environmentRoot: "CLAUDE_CONFIG_DIR",
  classify: classifyOwnership,
};
