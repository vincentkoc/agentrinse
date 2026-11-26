import { join } from "node:path";
import { classifyOwnership } from "./native-maintenance.js";
import type { ProviderSpec } from "../provider.js";

export const cursorRuleset: ProviderSpec = {
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
  classify: classifyOwnership,
};
