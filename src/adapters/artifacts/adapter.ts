import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentRinseConfig } from "../../config/schema.js";
import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import { artifactNameSchema, type ArtifactRemoveAction } from "../../contracts/action.js";
import type { Diagnostic } from "../../contracts/diagnostic.js";
import type { Finding, RootEvidence } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import { measurePath } from "../../core/measure.js";
import { findMountBoundaries, type MountBoundaryResult } from "../../core/mount-boundaries.js";
import {
  findProcessesUsingPath,
  type ProcessOwnershipResult,
} from "../../core/process-ownership.js";
import type { ReachabilityIndex } from "../../core/reachability.js";
import { isPathInside } from "../../core/safety.js";

type ArtifactOptions = AgentRinseConfig["artifacts"] & AgentRinseConfig["audit"];

export type ProcessProbe = (path: string) => Promise<ProcessOwnershipResult>;
export type MountProbe = (path: string) => Promise<MountBoundaryResult>;

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function rootEvidence(context: AuditContext, code: string, detail: string): RootEvidence {
  return {
    code,
    source: "artifacts",
    observedAt: context.now.toISOString(),
    detail,
  };
}

export class ArtifactAuditAdapter implements AuditAdapter {
  readonly id = "artifacts";

  constructor(
    private readonly options: ArtifactOptions,
    private readonly processProbe: ProcessProbe = findProcessesUsingPath,
    private readonly mountProbe: MountProbe = findMountBoundaries,
    private readonly reachability?: ReachabilityIndex,
  ) {}

  private async validProjects(context: AuditContext): Promise<{
    roots: string[];
    diagnostics: Diagnostic[];
  }> {
    const roots: string[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const project of this.options.projects) {
      const root = resolve(project.root);
      if (!isPathInside(context.home, root)) {
        diagnostics.push({
          severity: "error",
          code: "ARTIFACT_PROJECT_OUTSIDE_HOME",
          message: `Configured project is outside the audited home: ${root}`,
          adapter: this.id,
        });
        continue;
      }

      try {
        const stats = await lstat(root);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          diagnostics.push({
            severity: "error",
            code: "ARTIFACT_PROJECT_INVALID",
            message: `Configured project must be a real directory: ${root}`,
            adapter: this.id,
          });
          continue;
        }
        if ((await realpath(root)) !== root) {
          diagnostics.push({
            severity: "error",
            code: "ARTIFACT_PROJECT_NONCANONICAL",
            message: `Configured project path must not contain symlink aliases: ${root}`,
            adapter: this.id,
          });
          continue;
        }
        roots.push(root);
      } catch (error) {
        diagnostics.push({
          severity: isMissing(error) ? "warning" : "error",
          code: isMissing(error) ? "ARTIFACT_PROJECT_MISSING" : "ARTIFACT_PROJECT_UNREADABLE",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
      }
    }

    return { roots, diagnostics };
  }

  async probe(context: AuditContext): Promise<AdapterProbe> {
    const validation = await this.validProjects(context);
    if (validation.roots.length === 0) {
      return {
        adapter: this.id,
        status: this.options.projects.length === 0 ? "disabled" : "degraded",
        detail:
          this.options.projects.length === 0
            ? "No artifact project roots configured"
            : "No configured artifact project root is safe to inspect",
        diagnostics: validation.diagnostics,
      };
    }

    return {
      adapter: this.id,
      status: validation.diagnostics.length === 0 ? "available" : "degraded",
      root: context.home,
      detail: `${validation.roots.length} explicit artifact project root(s) available`,
      diagnostics: validation.diagnostics,
    };
  }

  async collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult> {
    if (!["available", "degraded"].includes(probe.status)) {
      return { resources: [], diagnostics: [] };
    }

    const validation = await this.validProjects(context);
    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const project of this.options.projects) {
      const projectRoot = resolve(project.root);
      if (!validation.roots.includes(projectRoot)) {
        continue;
      }
      const projectStats = await lstat(projectRoot);

      for (const name of project.names) {
        context.signal?.throwIfAborted();
        const path = resolve(join(projectRoot, name));
        if (!isPathInside(projectRoot, path)) {
          diagnostics.push({
            severity: "error",
            code: "ARTIFACT_PATH_ESCAPE",
            message: `Artifact path escaped its project root: ${path}`,
            adapter: this.id,
          });
          continue;
        }

        try {
          const stats = await lstat(path);
          const isDirectory = stats.isDirectory();
          const isSymlink = stats.isSymbolicLink();
          const measurement =
            isDirectory && !isSymlink && this.options.measureBytes
              ? await measurePath(path, {
                  maxEntries: this.options.maxEntries,
                  ...(context.signal === undefined ? {} : { signal: context.signal }),
                })
              : undefined;
          const ownership =
            isDirectory && !isSymlink
              ? await this.processProbe(path)
              : ({
                  status: "unknown",
                  matches: [],
                  reason: "resource is not a real directory",
                } satisfies ProcessOwnershipResult);
          const mounts =
            isDirectory && !isSymlink
              ? await this.mountProbe(path)
              : ({
                  status: "unknown",
                  paths: [],
                  reason: "resource is not a real directory",
                } satisfies MountBoundaryResult);
          const canonicalKey = `artifacts:build-artifact:${path}`;

          resources.push({
            resource: {
              id: `artifacts:build-artifact:${sha256(canonicalKey)}`,
              adapter: this.id,
              kind: "build-artifact",
              canonicalKey,
              displayName: name,
              path,
            },
            observedAt: context.now.toISOString(),
            exists: true,
            ...(measurement === undefined ? {} : { measuredBytes: measurement.bytes }),
            facts: {
              projectRoot,
              name,
              device: stats.dev,
              inode: stats.ino,
              mtimeMs: stats.mtimeMs,
              newestMtimeMs: measurement?.newestMtimeMs ?? stats.mtimeMs,
              fingerprint: measurement?.fingerprint,
              ageMinutes: Math.max(
                0,
                (context.now.getTime() - (measurement?.newestMtimeMs ?? stats.mtimeMs)) / 60_000,
              ),
              isDirectory,
              isSymlink,
              measurementTruncated: measurement?.truncated ?? false,
              specialEntries: measurement?.specialEntries ?? 0,
              mountBoundaries: measurement?.mountBoundaries ?? 0,
              isMountRoot: stats.dev !== projectStats.dev,
              entries: measurement?.entries,
              processOwnership: ownership,
              mountBoundaryStatus: mounts.status,
              mountBoundaryPaths: mounts.paths,
              mountBoundaryReason: mounts.status === "unknown" ? mounts.reason : undefined,
            },
          });
        } catch (error) {
          if (!isMissing(error)) {
            diagnostics.push({
              severity: "warning",
              code: "ARTIFACT_INSPECTION_FAILED",
              message: error instanceof Error ? error.message : String(error),
              adapter: this.id,
            });
          }
        }
      }
    }

    return { resources, diagnostics };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const facts = resource.facts;
    const roots: RootEvidence[] = [];
    const warnings: Diagnostic[] = [];
    let state: Finding["state"] = "eligible";
    let confidence: Finding["confidence"] = "certain";

    if (facts.isSymlink === true) {
      state = "blocked";
      confidence = "certain";
      warnings.push({
        severity: "warning",
        code: "ARTIFACT_SYMLINK_BLOCKED",
        message: "Artifact symlinks are never cleanup candidates.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    } else if (facts.isDirectory !== true) {
      state = "blocked";
      confidence = "certain";
      warnings.push({
        severity: "warning",
        code: "ARTIFACT_NOT_DIRECTORY",
        message: "Only declared artifact directories are supported.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    } else if (facts.measurementTruncated === true) {
      state = "blocked";
      confidence = "unknown";
      warnings.push({
        severity: "warning",
        code: "ARTIFACT_MEASUREMENT_TRUNCATED",
        message: "The entry budget was exhausted before measurement completed.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    } else if (typeof facts.specialEntries === "number" && facts.specialEntries > 0) {
      state = "blocked";
      confidence = "certain";
      warnings.push({
        severity: "warning",
        code: "ARTIFACT_SPECIAL_ENTRY",
        message: "Artifact cleanup only supports directories, regular files, and skipped symlinks.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    } else if (
      facts.isMountRoot === true ||
      facts.mountBoundaryStatus === "blocked" ||
      (typeof facts.mountBoundaries === "number" && facts.mountBoundaries > 0)
    ) {
      state = "blocked";
      confidence = "certain";
      warnings.push({
        severity: "warning",
        code: "ARTIFACT_MOUNT_BOUNDARY",
        message: "Artifact cleanup never crosses a filesystem mount boundary.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    } else if (facts.mountBoundaryStatus !== "clear") {
      state = "blocked";
      confidence = "unknown";
      warnings.push({
        severity: "warning",
        code: "ARTIFACT_MOUNT_INSPECTION_UNKNOWN",
        message: "Filesystem mount boundaries could not be proven absent.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    } else if (
      resource.measuredBytes === undefined ||
      resource.measuredBytes < this.options.minBytes
    ) {
      state = "protected";
      roots.push(
        rootEvidence(
          context,
          "artifact-below-size-threshold",
          `Artifact is smaller than ${this.options.minBytes} bytes.`,
        ),
      );
    } else if (
      typeof facts.ageMinutes !== "number" ||
      facts.ageMinutes < this.options.minAgeMinutes
    ) {
      state = "protected";
      roots.push(
        rootEvidence(
          context,
          "recent-resource",
          `Artifact is newer than ${this.options.minAgeMinutes} minutes.`,
        ),
      );
    }

    const ownership = facts.processOwnership as ProcessOwnershipResult | undefined;
    if (state === "eligible" && ownership?.status === "busy") {
      state = "protected";
      roots.push(
        rootEvidence(
          context,
          "live-process",
          "A same-user process owns a cwd or file descriptor under the artifact.",
        ),
      );
    } else if (state === "eligible" && ownership?.status !== "idle") {
      state = "blocked";
      confidence = "unknown";
      warnings.push({
        severity: "warning",
        code: "PROCESS_OWNERSHIP_UNKNOWN",
        message: "Process ownership could not be proven idle.",
        adapter: this.id,
        resourceId: resource.resource.id,
      });
    }

    const reachabilityRoots = this.reachability?.rootsForResource(
      resource.resource,
      resource.facts,
      context.now.toISOString(),
    );
    if (reachabilityRoots !== undefined && reachabilityRoots.length > 0) {
      roots.push(...reachabilityRoots);
      if (state === "eligible") {
        state = "protected";
      }
    }
    roots.sort((left, right) => {
      const byCode = left.code.localeCompare(right.code);
      return byCode !== 0 ? byCode : left.source.localeCompare(right.source);
    });

    const candidateActions: ArtifactRemoveAction[] =
      state === "eligible" ? [this.actionFor(resource)] : [];

    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt: context.now.toISOString(),
      resource: resource.resource,
      state,
      confidence,
      roots,
      facts,
      candidateActions,
      ...(resource.measuredBytes === undefined
        ? {}
        : {
            measuredBytes: resource.measuredBytes,
            estimatedReclaimBytes: state === "eligible" ? resource.measuredBytes : 0,
          }),
      warnings,
    };
  }

  private actionFor(resource: ResourceSnapshot): ArtifactRemoveAction {
    const facts = resource.facts;
    const target = {
      path: resource.resource.path!,
      projectRoot: String(facts.projectRoot),
      name: artifactNameSchema.parse(facts.name),
      device: Number(facts.device),
      inode: Number(facts.inode),
      mtimeMs: Number(facts.mtimeMs),
      measuredBytes: resource.measuredBytes!,
      newestMtimeMs: Number(facts.newestMtimeMs),
      fingerprint: String(facts.fingerprint),
    };

    return {
      actionId: `artifacts.remove:${sha256(JSON.stringify(target))}`,
      type: "artifacts.remove",
      adapter: "artifacts",
      resourceId: resource.resource.id,
      risk: "safe",
      description: `Remove rebuildable ${target.name} from ${target.projectRoot}`,
      expectedReclaimBytes: target.measuredBytes,
      target,
    };
  }
}
