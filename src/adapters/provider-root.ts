import { isOpenClawProfileName } from "../rules/openclaw/profile.js";
import { isAbsolute, join, resolve } from "node:path";

import type { ProviderSpec } from "./provider-specs.js";

export type ProviderRootOptions = {
  root?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

function resolveAbsoluteEnvironmentPath(
  name: string,
  value: string | undefined,
): string | undefined {
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
    if (spec.id === "openclaw" && !isAbsolute(options.root)) {
      throw new Error("OpenClaw adapter root must be an absolute path");
    }
    return resolve(options.root);
  }
  if (spec.id === "openclaw") {
    const environment = options.environment ?? process.env;
    const stateDir = resolveAbsoluteEnvironmentPath(
      "OPENCLAW_STATE_DIR",
      environment.OPENCLAW_STATE_DIR?.trim(),
    );
    if (stateDir !== undefined) {
      return stateDir;
    }
    const ownerHome =
      resolveAbsoluteEnvironmentPath("OPENCLAW_HOME", environment.OPENCLAW_HOME?.trim()) ?? home;
    const profile = environment.OPENCLAW_PROFILE?.trim();
    if (!profile || profile.toLowerCase() === "default") {
      return spec.defaultRoot(ownerHome, options.platform ?? process.platform);
    }
    if (!isOpenClawProfileName(profile)) {
      throw new Error("Invalid OPENCLAW_PROFILE");
    }
    return join(ownerHome, `.openclaw-${profile}`);
  }
  if (
    spec.id === "zed" &&
    (options.platform ?? process.platform) !== "darwin" &&
    (options.platform ?? process.platform) !== "win32"
  ) {
    const environment = options.environment ?? process.env;
    const dataHome =
      resolveAbsoluteEnvironmentPath("FLATPAK_XDG_DATA_HOME", environment.FLATPAK_XDG_DATA_HOME) ??
      resolveAbsoluteEnvironmentPath("XDG_DATA_HOME", environment.XDG_DATA_HOME);
    if (dataHome !== undefined) {
      return join(dataHome, "zed");
    }
  }
  const environmentVariable = spec.environmentRoot;
  if (environmentVariable !== undefined) {
    const configuredRoot = resolveAbsoluteEnvironmentPath(
      environmentVariable,
      options.environment?.[environmentVariable],
    );
    if (configuredRoot !== undefined) {
      return configuredRoot;
    }
  }
  return resolve(spec.defaultRoot(resolve(home), options.platform ?? process.platform));
}
