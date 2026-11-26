import { classifyOwnership } from "./native-maintenance.js";
import { homePath, type ProviderSpec } from "../provider.js";

export const opencodeRuleset: ProviderSpec = {
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
  classify: classifyOwnership,
};
