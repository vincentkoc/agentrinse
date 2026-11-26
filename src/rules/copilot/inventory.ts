import { classifyOwnership } from "./native-maintenance.js";
import { homePath, type ProviderSpec } from "../provider.js";

export const copilotRuleset: ProviderSpec = {
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
  environmentRoot: "COPILOT_HOME",
  classify: classifyOwnership,
};
