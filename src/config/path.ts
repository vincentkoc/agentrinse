import { resolve } from "node:path";

export type ConfigEnvironment = {
  XDG_CONFIG_HOME?: string;
};

export function resolveConfigPath(
  home: string,
  explicit?: string,
  environment: ConfigEnvironment = process.env,
): string {
  if (explicit !== undefined) {
    return resolve(explicit);
  }
  if (environment.XDG_CONFIG_HOME !== undefined) {
    return resolve(environment.XDG_CONFIG_HOME, "agentrinse", "config.json");
  }
  return resolve(home, ".config", "agentrinse", "config.json");
}
