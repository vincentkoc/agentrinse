import { join, resolve } from "node:path";

export type StateEnvironment = {
  XDG_STATE_HOME?: string;
};

export type StateLayout = {
  root: string;
  locks: string;
  runs: string;
  tombstones: string;
};

export function resolveStateRoot(
  home: string,
  explicit?: string,
  environment: StateEnvironment = process.env,
): string {
  if (explicit !== undefined) {
    return resolve(explicit);
  }
  if (environment.XDG_STATE_HOME !== undefined) {
    return resolve(environment.XDG_STATE_HOME, "agentrinse");
  }
  return resolve(home, ".local", "state", "agentrinse");
}

export function stateLayout(root: string): StateLayout {
  const resolved = resolve(root);
  return {
    root: resolved,
    locks: join(resolved, "locks"),
    runs: join(resolved, "runs"),
    tombstones: join(resolved, "tombstones"),
  };
}
