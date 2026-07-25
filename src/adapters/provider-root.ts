import { isAbsolute, resolve } from "node:path";

import type { ProviderSpec } from "./provider-specs.js";

export type ProviderRootOptions = {
  root?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export function resolveProviderRoot(
  spec: ProviderSpec,
  home: string,
  options: ProviderRootOptions = {},
): string {
  if (options.root !== undefined) {
    return resolve(options.root);
  }
  if (spec.id === "claude") {
    const configuredRoot = options.environment?.CLAUDE_CONFIG_DIR;
    if (configuredRoot !== undefined && configuredRoot !== "") {
      if (!isAbsolute(configuredRoot)) {
        throw new Error("CLAUDE_CONFIG_DIR must be an absolute path");
      }
      return resolve(configuredRoot);
    }
  }
  return resolve(spec.defaultRoot(resolve(home), options.platform ?? process.platform));
}
