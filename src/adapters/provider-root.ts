import { isAbsolute, resolve } from "node:path";

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
  return undefined;
}

export function resolveProviderRoot(
  spec: ProviderSpec,
  home: string,
  options: ProviderRootOptions = {},
): string {
  if (options.root !== undefined) {
    return resolve(options.root);
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
