import { join } from "node:path";
import type { ProviderSpec } from "../provider.js";

export const zedRuleset: ProviderSpec = {
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
};
