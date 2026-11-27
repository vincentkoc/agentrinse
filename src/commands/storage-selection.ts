import { dirname, isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "../core/safety.js";
import { suppliedLocations } from "../rules/storage/supplied-locations.js";
import { laneCacheRules } from "../rules/openclaw/lane-caches.js";
import type { StorageOptions } from "./storage.js";
import type { Location } from "../rules/storage/location.js";

export function literal(path: string): string {
  if (!isAbsolute(path) || /\p{Cc}/u.test(path) || resolve(path) !== path)
    throw new Error("Storage paths must be absolute and normalized");
  return path;
}

export function selectStorageLocations(
  options: StorageOptions,
  home: string,
  catalog: readonly Location[],
) {
  const supplied = [...new Set(options.at)].map((value) => {
    const equal = value.indexOf("=");
    const rule = suppliedLocations.find((candidate) => candidate.id === value.slice(0, equal));
    if (equal < 1 || !rule)
      throw new Error("--at requires a known supplied rule and an absolute path");
    const path = literal(value.slice(equal + 1));
    if (path === home || path === dirname(path))
      throw new Error("Select a specific retained location");
    return {
      rule: rule.id,
      owner: rule.owner,
      reason: rule.reason,
      path,
      scope: "retained" as const,
    };
  });
  const projects = [...new Set((options.project ?? []).map(literal))];
  if (projects.length + supplied.length > 64)
    throw new Error("At most 64 explicit storage paths are supported");
  const projectAreas = projects.flatMap((project) => {
    if (isPathInside(project, home) || project === dirname(project))
      throw new Error("Select a specific project");
    return suppliedLocations.flatMap((rule) =>
      "projectRelative" in rule
        ? [
            {
              project,
              rule: rule.id,
              owner: rule.owner,
              reason: rule.reason,
              path: join(project, rule.projectRelative),
              scope: "retained" as const,
            },
          ]
        : [],
    );
  });
  const rules = new Set(options.rule);
  const explicitLocations = Boolean(
    rules.size || supplied.length || projectAreas.length || options.system,
  );
  if (
    [...rules].some(
      (id) =>
        !catalog.some((entry) => entry.id === id) &&
        !laneCacheRules.some((entry) => entry.id === id) &&
        ![...supplied, ...projectAreas].some((entry) => entry.rule === id),
    )
  )
    throw new Error("Unknown storage rule on this platform");
  return { rules, supplied, projects, projectAreas, explicitLocations };
}
