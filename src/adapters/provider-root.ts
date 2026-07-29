import { isAbsolute, join, resolve } from "node:path";

import type { ProviderSpec } from "./provider-specs.js";

export type ProviderRootOptions = {
  root?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function providerRootEnvironment(spec: ProviderSpec): string | undefined {
  if (spec.id === "claude") {
    return "CLAUDE_CONFIG_DIR";
  }
  if (spec.id === "copilot") {
    return "COPILOT_HOME";
  }
  if (spec.id === "grok") {
    return "GROK_HOME";
  }
  return undefined;
}

function resolveAbsoluteEnvironmentPath(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

export function resolveProviderRoot(
  spec: ProviderSpec,
  home: string,
  options: ProviderRootOptions = {},
): string {
  if (options.root !== undefined) {
    return resolve(options.root);
  }
  if (
    spec.id === "zed" &&
    (options.platform ?? process.platform) !== "darwin" &&
    (options.platform ?? process.platform) !== "win32"
  ) {
    const environment = options.environment ?? process.env;
    const dataHome =
      resolveAbsoluteEnvironmentPath(environment, "FLATPAK_XDG_DATA_HOME") ??
      resolveAbsoluteEnvironmentPath(environment, "XDG_DATA_HOME");
    if (dataHome !== undefined) {
      return join(dataHome, "zed");
    }
  }
  const environmentVariable = providerRootEnvironment(spec);
  if (environmentVariable !== undefined) {
    const configuredRoot = options.environment?.[environmentVariable];
    if (configuredRoot !== undefined && configuredRoot !== "") {
      if (!isAbsolute(configuredRoot)) {
        throw new Error(`${environmentVariable} must be an absolute path`);
      }
      return resolve(configuredRoot);
    }
  }
  return resolve(spec.defaultRoot(resolve(home), options.platform ?? process.platform));
}
