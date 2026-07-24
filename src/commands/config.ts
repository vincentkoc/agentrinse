import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { loadConfig, loadConfigForHome } from "../config/load.js";
import { resolveConfigPath, type ConfigEnvironment } from "../config/path.js";
import type { AgentRinseConfig } from "../config/schema.js";
import { writeJsonExclusive } from "../state/json-file.js";

export type ConfigCommandOptions = {
  home: string;
  config?: string | undefined;
  environment?: ConfigEnvironment | undefined;
};

export type ConfigCommandResult = {
  path: string;
  output: string;
  config?: AgentRinseConfig;
};

function targetPath(options: ConfigCommandOptions): string {
  return resolveConfigPath(
    resolve(options.home),
    options.config,
    options.environment ?? process.env,
  );
}

export function executeConfigPathCommand(options: ConfigCommandOptions): ConfigCommandResult {
  const path = targetPath(options);
  return { path, output: `${path}\n` };
}

export async function executeConfigInitCommand(
  options: ConfigCommandOptions,
): Promise<ConfigCommandResult> {
  const path = targetPath(options);
  await writeJsonExclusive(path, DEFAULT_CONFIG);
  return {
    path,
    config: structuredClone(DEFAULT_CONFIG),
    output: `created ${path}\n`,
  };
}

export async function executeConfigShowCommand(
  options: ConfigCommandOptions,
): Promise<ConfigCommandResult> {
  const loaded = await loadConfigForHome(
    options.home,
    options.config,
    options.environment ?? process.env,
  );
  return {
    path: loaded.path,
    config: loaded.config,
    output: `${JSON.stringify(loaded.config, null, 2)}\n`,
  };
}

export async function executeConfigValidateCommand(
  options: ConfigCommandOptions,
): Promise<ConfigCommandResult> {
  const path = targetPath(options);
  await access(path);
  const config = await loadConfig(path);
  return {
    path,
    config,
    output: `valid ${path}\n`,
  };
}
