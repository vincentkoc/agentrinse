import { join } from "node:path";

import type { AdapterId } from "../config/schema.js";
import type { ResourceKind } from "../contracts/resource.js";

export type ProviderAdapterId = Exclude<AdapterId, "git" | "docker" | "runtime">;

export type ProviderResourceSpec = {
  relativePath: string;
  displayName: string;
  kind: ResourceKind;
};

export type ProviderSpec = {
  id: ProviderAdapterId;
  displayName: string;
  defaultRoot(home: string, platform: NodeJS.Platform): string;
  resources: ProviderResourceSpec[];
};

function homePath(...segments: string[]) {
  return (home: string): string => join(home, ...segments);
}

export const PROVIDER_SPECS: Record<ProviderAdapterId, ProviderSpec> = {
  codex: {
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
  },
  claude: {
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
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    defaultRoot(home, platform) {
      if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Cursor");
      }
      if (platform === "win32") {
        return join(home, "AppData", "Roaming", "Cursor");
      }
      return join(home, ".config", "Cursor");
    },
    resources: [
      {
        relativePath: join("User", "workspaceStorage"),
        displayName: "Cursor workspace state",
        kind: "agent-session-store",
      },
      {
        relativePath: join("User", "globalStorage", "state.vscdb"),
        displayName: "Cursor global state database",
        kind: "agent-database",
      },
      {
        relativePath: "logs",
        displayName: "Cursor logs",
        kind: "agent-log-store",
      },
    ],
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    defaultRoot: homePath(".copilot"),
    resources: [
      {
        relativePath: "session-state",
        displayName: "Copilot CLI session state",
        kind: "agent-session-store",
      },
      {
        relativePath: "logs",
        displayName: "Copilot CLI logs",
        kind: "agent-log-store",
      },
    ],
  },
  zed: {
    id: "zed",
    displayName: "Zed",
    defaultRoot(home, platform) {
      if (platform === "darwin") {
        return join(home, "Library", "Application Support", "Zed");
      }
      if (platform === "win32") {
        return join(home, "AppData", "Local", "Zed");
      }
      return join(home, ".local", "share", "zed");
    },
    resources: [
      {
        relativePath: ".",
        displayName: "Zed user data",
        kind: "agent-home",
      },
    ],
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    defaultRoot: homePath(".local", "share", "opencode"),
    resources: [
      {
        relativePath: "opencode.db",
        displayName: "OpenCode database",
        kind: "agent-database",
      },
      {
        relativePath: "log",
        displayName: "OpenCode logs",
        kind: "agent-log-store",
      },
      {
        relativePath: "snapshot",
        displayName: "OpenCode snapshots",
        kind: "agent-snapshot-store",
      },
    ],
  },
  grok: {
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
  },
};

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_SPECS) as ProviderAdapterId[]);
