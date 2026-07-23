import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { AgentRinseConfig } from "../config/schema.js";
import type { ArtifactRemoveAction } from "../contracts/action.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import { measurePath, type Measurement } from "./measure.js";
import { findProcessesUsingPath, type ProcessOwnershipResult } from "./process-ownership.js";
import { isPathInside } from "./safety.js";

export type ArtifactRevalidationResult =
  | { status: "valid"; measurement: Measurement }
  | { status: "stale"; diagnostic: Diagnostic };

export type ArtifactRevalidationDependencies = {
  cwd?: string;
  measure?: typeof measurePath;
  processProbe?: (path: string) => Promise<ProcessOwnershipResult>;
};

function stale(
  action: ArtifactRemoveAction,
  code: string,
  message: string,
): ArtifactRevalidationResult {
  return {
    status: "stale",
    diagnostic: {
      severity: "warning",
      code,
      message,
      adapter: action.adapter,
      resourceId: action.resourceId,
    },
  };
}

function isConfigured(action: ArtifactRemoveAction, config: AgentRinseConfig): boolean {
  const targetRoot = resolve(action.target.projectRoot);
  return config.artifacts.projects.some(
    (project) => resolve(project.root) === targetRoot && project.names.includes(action.target.name),
  );
}

export async function revalidateArtifactRemove(
  action: ArtifactRemoveAction,
  home: string,
  config: AgentRinseConfig,
  dependencies: ArtifactRevalidationDependencies = {},
): Promise<ArtifactRevalidationResult> {
  const projectRoot = resolve(action.target.projectRoot);
  const targetPath = resolve(action.target.path);
  const expectedPath = resolve(join(projectRoot, action.target.name));

  if (
    !isAbsolute(action.target.projectRoot) ||
    !isAbsolute(action.target.path) ||
    targetPath !== expectedPath ||
    !isPathInside(home, projectRoot) ||
    !isPathInside(projectRoot, targetPath) ||
    !isConfigured(action, config)
  ) {
    return stale(
      action,
      "ARTIFACT_SCOPE_CHANGED",
      "artifact path is no longer within the exact configured cleanup scope",
    );
  }

  const cwd = resolve(dependencies.cwd ?? process.cwd());
  if (isPathInside(targetPath, cwd)) {
    return stale(
      action,
      "ARTIFACT_OWNS_CWD",
      "artifact is the current working directory or one of its ancestors",
    );
  }

  try {
    const [homeStats, projectStats, targetStats] = await Promise.all([
      lstat(resolve(home)),
      lstat(projectRoot),
      lstat(targetPath),
    ]);
    if (
      !homeStats.isDirectory() ||
      homeStats.isSymbolicLink() ||
      !projectStats.isDirectory() ||
      projectStats.isSymbolicLink() ||
      !targetStats.isDirectory() ||
      targetStats.isSymbolicLink()
    ) {
      return stale(
        action,
        "ARTIFACT_TYPE_CHANGED",
        "home, project root, and artifact must remain real directories",
      );
    }

    const [homeReal, projectReal, targetReal] = await Promise.all([
      realpath(resolve(home)),
      realpath(projectRoot),
      realpath(targetPath),
    ]);
    if (
      !isPathInside(homeReal, projectReal) ||
      targetReal !== resolve(join(projectReal, action.target.name))
    ) {
      return stale(
        action,
        "ARTIFACT_REALPATH_CHANGED",
        "artifact realpath no longer matches its planned project root",
      );
    }

    if (
      targetStats.dev !== action.target.device ||
      targetStats.ino !== action.target.inode ||
      targetStats.mtimeMs !== action.target.mtimeMs
    ) {
      return stale(
        action,
        "ARTIFACT_IDENTITY_CHANGED",
        "artifact filesystem identity changed after planning",
      );
    }

    const measurement = await (dependencies.measure ?? measurePath)(targetPath, {
      maxEntries: config.audit.maxEntries,
    });
    if (
      measurement.truncated ||
      measurement.bytes !== action.target.measuredBytes ||
      measurement.newestMtimeMs !== action.target.newestMtimeMs ||
      measurement.fingerprint !== action.target.fingerprint
    ) {
      return stale(
        action,
        "ARTIFACT_CONTENT_CHANGED",
        "artifact contents changed or could not be measured completely",
      );
    }

    const ownership = await (dependencies.processProbe ?? findProcessesUsingPath)(targetPath);
    if (ownership.status !== "idle") {
      return stale(
        action,
        ownership.status === "busy" ? "ARTIFACT_PROCESS_ACTIVE" : "ARTIFACT_PROCESS_UNKNOWN",
        ownership.status === "busy"
          ? "a same-user process currently owns the artifact"
          : "process ownership could not be proven idle",
      );
    }

    return { status: "valid", measurement };
  } catch (error) {
    return stale(
      action,
      "ARTIFACT_REVALIDATION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}
