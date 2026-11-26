import { classifyCodexDatabase } from "./database-vacuum.js";
import { homePath, type ProviderSpec } from "../provider.js";

export const codexRuleset: ProviderSpec = {
  id: "codex",
  displayName: "OpenAI Codex",
  defaultRoot: homePath(".codex"),
  resources: [
    {
      relativePath: "sessions",
      displayName: "Codex sessions",
      kind: "agent-session-store",
    },
    {
      relativePath: "archived_sessions",
      displayName: "Codex archived sessions",
      kind: "agent-session-store",
    },
    {
      relativePath: "worktrees",
      displayName: "Codex managed worktrees",
      kind: "git-worktree",
    },
    {
      relativePath: "logs_2.sqlite",
      displayName: "Codex diagnostic database",
      kind: "agent-database",
    },
    {
      relativePath: "state_5.sqlite",
      displayName: "Codex state database",
      kind: "agent-database",
    },
    {
      relativePath: "goals_1.sqlite",
      displayName: "Codex goals database",
      kind: "agent-database",
    },
    {
      relativePath: "memories_1.sqlite",
      displayName: "Codex memories database",
      kind: "agent-database",
    },
  ],
  classify: classifyCodexDatabase,
};
