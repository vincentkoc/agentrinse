import { collectProviderFiles } from "./provider-file-discovery.js";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { classifyProviderOwnership } from "./provider-ownership-classification.js";
import { classifyCodexDatabase } from "./codex-database-classification.js";
import type {
  AuditAdapter,
  AuditContext,
  CollectionObserver,
  CollectionResult,
} from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { Finding } from "../contracts/finding.js";
import type { AdapterProbe } from "../contracts/report.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { sha256 } from "../core/digest.js";
import { measurePath } from "../core/measure.js";
import { classifyProviderFile } from "./provider-file-classification.js";
import type { ReachabilityIndex } from "../core/reachability.js";
import {
  inspectCodexDatabase,
  inspectCodexProcesses,
  inspectDatabaseOpenHandles,
  type CodexDatabaseDependencies,
  type CodexDatabaseInspection,
} from "./codex-database.js";
import { inspectClaudeNativeRetention, usesClaudeNativeRetention } from "./claude-retention.js";
import { copilotNativeMaintenanceFor } from "./copilot-maintenance.js";
import {
  cursorNativeMaintenanceFor,
  inspectCursorDatabaseCompanions,
  inspectCursorDatabaseParents,
} from "./cursor-maintenance.js";
import { inspectGrokOwnerContract, type GrokVersionRunner } from "./grok-maintenance.js";
import { opencodeNativeMaintenanceFor } from "./opencode-maintenance.js";
import { collectProviderReachability } from "./provider-reachability.js";
import { collectOpenClaw } from "./openclaw.js";
import { OPENCLAW_OWNER_UNKNOWN } from "./openclaw-ownership.js";
import { resolveProviderRoot } from "./provider-root.js";
import type { ProviderSpec } from "./provider-specs.js";

export type ProviderAdapterOptions = {
  root?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  measureBytes: boolean;
  maxEntries: number;
  reachability?: ReachabilityIndex;
  inventoryResources?: boolean;
  quickInventory?: boolean;
  allowOfflineVacuum?: boolean;
  databaseDependencies?: CodexDatabaseDependencies;
  inspectDatabase?: (
    path: string,
    dependencies?: CodexDatabaseDependencies,
  ) => Promise<CodexDatabaseInspection>;
  runGrokVersion?: GrokVersionRunner;
};

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class ProviderAuditAdapter implements AuditAdapter {
  readonly id: string;

  constructor(
    private readonly spec: ProviderSpec,
    private readonly options: ProviderAdapterOptions,
  ) {
    this.id = spec.id;
  }

  private root(context: AuditContext): string {
    return resolveProviderRoot(this.spec, context.home, this.options);
  }

  async probe(context: AuditContext): Promise<AdapterProbe> {
    let root: string;
    try {
      root = this.root(context);
    } catch (error) {
      return {
        adapter: this.id,
        status: "degraded",
        detail: `${this.spec.displayName} root configuration is invalid`,
        diagnostics: [
          {
            severity: "warning",
            code: "PROVIDER_ROOT_INVALID",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          },
        ],
      };
    }

    try {
      const stats = await lstat(root);
      if (stats.isSymbolicLink()) {
        return {
          adapter: this.id,
          status: "degraded",
          root,
          detail: `${this.spec.displayName} root is a symlink; audit is blocked`,
          diagnostics: [
            {
              severity: "warning",
              code: "PROVIDER_ROOT_SYMLINK",
              message: "Provider roots must resolve without following symlinks.",
              adapter: this.id,
            },
          ],
        };
      }

      if (!stats.isDirectory()) {
        return {
          adapter: this.id,
          status: "degraded",
          root,
          detail: `${this.spec.displayName} root is not a directory`,
          diagnostics: [
            {
              severity: "warning",
              code: "PROVIDER_ROOT_NOT_DIRECTORY",
              message: "The configured provider root is not a directory.",
              adapter: this.id,
            },
          ],
        };
      }

      return {
        adapter: this.id,
        status: "available",
        root,
        detail: `${this.spec.displayName} data root found`,
        diagnostics: [],
      };
    } catch (error) {
      if (isMissing(error)) {
        return {
          adapter: this.id,
          status: "absent",
          root,
          detail: `${this.spec.displayName} data root not found`,
          diagnostics: [],
        };
      }

      return {
        adapter: this.id,
        status: "degraded",
        root,
        detail: `${this.spec.displayName} data root could not be inspected`,
        diagnostics: [
          {
            severity: "warning",
            code: "PROVIDER_ROOT_UNREADABLE",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          },
        ],
      };
    }
  }

  async collect(
    context: AuditContext,
    probe: AdapterProbe,
    observer?: CollectionObserver,
  ): Promise<CollectionResult> {
    if (probe.status !== "available" || probe.root === undefined) {
      if (this.id === "openclaw" && probe.status === "degraded") {
        this.options.reachability?.addGlobal({
          code: OPENCLAW_OWNER_UNKNOWN,
          source: this.id,
          detail: "OpenClaw ownership could not be inspected.",
        });
      }
      if (
        probe.status === "degraded" &&
        this.options.reachability !== undefined &&
        (this.spec.id === "codex" || this.spec.id === "claude")
      ) {
        this.options.reachability.addGlobal({
          code: "unknown-provider-state",
          source: this.spec.id,
          detail: `${this.spec.displayName} ownership metadata could not be inspected.`,
        });
      }
      if (
        probe.status === "absent" &&
        this.options.quickInventory !== true &&
        this.options.inventoryResources !== false
      ) {
        const collection = await collectProviderFiles(this.spec.id, context, this.options);
        for (const resource of collection.resources) {
          observer?.reportResource(resource);
        }
        for (const diagnostic of collection.diagnostics) {
          observer?.reportDiagnostic(diagnostic);
        }
        return collection;
      }
      return { resources: [], diagnostics: [] };
    }

    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];
    const addResources = (...reportedResources: ResourceSnapshot[]): void => {
      resources.push(...reportedResources);
      for (const resource of reportedResources) {
        observer?.reportResource(resource);
      }
    };
    const addDiagnostics = (...reportedDiagnostics: Diagnostic[]): void => {
      diagnostics.push(...reportedDiagnostics);
      for (const diagnostic of reportedDiagnostics) {
        observer?.reportDiagnostic(diagnostic);
      }
    };

    if (this.id === "openclaw" && this.options.quickInventory !== true) {
      try {
        await collectOpenClaw(context, probe.root, this.options, {
          reportResource: addResources,
          reportDiagnostic: addDiagnostics,
        });
      } catch (error) {
        this.options.reachability?.addGlobal({
          code: OPENCLAW_OWNER_UNKNOWN,
          source: this.id,
          detail: "OpenClaw inventory did not complete.",
        });
        throw error;
      }
      return { resources, diagnostics };
    }
    if (this.options.reachability !== undefined) {
      addDiagnostics(
        ...(await collectProviderReachability(
          this.spec.id,
          context,
          probe.root,
          this.options.reachability,
        )),
      );
    }
    if (this.options.inventoryResources === false) {
      return { resources: [], diagnostics };
    }
    const claudeRetention =
      this.options.quickInventory !== true && this.spec.id === "claude"
        ? await inspectClaudeNativeRetention(probe.root, this.options.platform ?? process.platform)
        : undefined;
    if (claudeRetention !== undefined) {
      addDiagnostics(...claudeRetention.diagnostics);
    }
    const grokOwnerContract =
      this.options.quickInventory !== true && this.spec.id === "grok"
        ? await inspectGrokOwnerContract(
            probe.root,
            this.options.environment ?? process.env,
            this.options.platform ?? process.platform,
            this.options.runGrokVersion,
          )
        : undefined;
    const candidates =
      grokOwnerContract !== undefined && grokOwnerContract.installedVersionStatus !== "exact"
        ? [
            {
              relativePath: ".",
              displayName: "Grok Build data",
              kind: "agent-home" as const,
            },
          ]
        : this.spec.resources;

    for (const candidate of candidates) {
      context.signal?.throwIfAborted();
      const path =
        candidate.relativePath === "." ? probe.root : join(probe.root, candidate.relativePath);
      const copilotNativeMaintenance =
        this.options.quickInventory !== true && this.spec.id === "copilot"
          ? copilotNativeMaintenanceFor(candidate.relativePath)
          : undefined;
      const opencodeNativeMaintenance =
        this.options.quickInventory !== true && this.spec.id === "opencode"
          ? opencodeNativeMaintenanceFor(candidate.relativePath)
          : undefined;
      const cursorNativeMaintenance =
        this.options.quickInventory !== true && this.spec.id === "cursor"
          ? cursorNativeMaintenanceFor(candidate.relativePath)
          : undefined;
      const canonicalKey = `${this.id}:${candidate.kind}:${resolve(path)}`;
      const resourceId = `${this.id}:${candidate.kind}:${sha256(canonicalKey)}`;
      if (cursorNativeMaintenance !== undefined) {
        const parentInspection = await inspectCursorDatabaseParents(
          probe.root,
          candidate.relativePath,
        );
        if (parentInspection.status === "missing") {
          continue;
        }
        if (parentInspection.status === "blocked") {
          addDiagnostics({
            severity: "warning",
            code:
              parentInspection.code === "symlink"
                ? "RESOURCE_PARENT_SYMLINK_SKIPPED"
                : "RESOURCE_PARENT_INSPECTION_FAILED",
            message: parentInspection.reason,
            adapter: this.id,
          });
          continue;
        }
      }

      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) {
          addDiagnostics({
            severity: "warning",
            code: "RESOURCE_SYMLINK_SKIPPED",
            message: "A provider resource symlink was not followed.",
            adapter: this.id,
          });
          continue;
        }

        const isCodexDatabase =
          this.spec.id === "codex" &&
          candidate.kind === "agent-database" &&
          this.options.allowOfflineVacuum === true;
        const databaseInspection = isCodexDatabase
          ? await (this.options.inspectDatabase ?? inspectCodexDatabase)(
              path,
              this.options.databaseDependencies,
            )
          : undefined;
        const measurement =
          databaseInspection === undefined && this.options.measureBytes
            ? await measurePath(path, {
                maxEntries: this.options.maxEntries,
                ...(context.signal === undefined ? {} : { signal: context.signal }),
              })
            : undefined;
        const openHandles =
          databaseInspection === undefined
            ? undefined
            : await inspectDatabaseOpenHandles(path, this.options.databaseDependencies);
        const ownerProcesses =
          databaseInspection === undefined
            ? undefined
            : await inspectCodexProcesses(this.options.databaseDependencies);
        const cursorDatabaseCompanions =
          cursorNativeMaintenance === undefined
            ? undefined
            : await inspectCursorDatabaseCompanions(path, this.options.measureBytes);

        addResources({
          resource: {
            id: resourceId,
            adapter: this.id,
            kind: candidate.kind,
            canonicalKey,
            displayName: candidate.displayName,
            path: resolve(path),
          },
          observedAt: context.now.toISOString(),
          exists: true,
          ...(databaseInspection !== undefined
            ? { measuredBytes: databaseInspection.identity.measuredBytes }
            : measurement === undefined
              ? {}
              : { measuredBytes: measurement.bytes }),
          facts: {
            reportOnly: databaseInspection === undefined,
            entries: measurement?.entries,
            symlinksSkipped: measurement?.symlinksSkipped,
            measurementTruncated: measurement?.truncated,
            ...(claudeRetention !== undefined && usesClaudeNativeRetention(candidate.relativePath)
              ? { nativeRetention: claudeRetention.facts }
              : {}),
            ...(copilotNativeMaintenance === undefined
              ? {}
              : { nativeMaintenance: copilotNativeMaintenance }),
            ...(opencodeNativeMaintenance === undefined
              ? {}
              : { nativeMaintenance: opencodeNativeMaintenance }),
            ...(cursorNativeMaintenance === undefined
              ? {}
              : {
                  nativeMaintenance: cursorNativeMaintenance,
                  databaseCompanions: cursorDatabaseCompanions,
                }),
            ...(grokOwnerContract === undefined ? {} : { ownerContract: grokOwnerContract }),
            ...(databaseInspection === undefined
              ? {}
              : {
                  maintenanceAction: "database.vacuum",
                  databaseIdentity: databaseInspection.identity,
                  estimatedReclaimBytes: databaseInspection.estimatedReclaimBytes,
                  freePageRatio: databaseInspection.freePageRatio,
                  quickCheck: databaseInspection.quickCheck,
                  walBytes: databaseInspection.walBytes,
                  shmBytes: databaseInspection.shmBytes,
                  sidecarsPresent: databaseInspection.sidecarsPresent,
                  ownerProcesses,
                  openHandles,
                  offlineVacuumAllowed: this.options.allowOfflineVacuum === true,
                }),
          },
        });
      } catch (error) {
        if (isMissing(error)) {
          if (cursorNativeMaintenance !== undefined) {
            const cursorDatabaseCompanions = await inspectCursorDatabaseCompanions(
              path,
              this.options.measureBytes,
            );
            if (cursorDatabaseCompanions.some((companion) => companion.status !== "missing")) {
              addResources({
                resource: {
                  id: resourceId,
                  adapter: this.id,
                  kind: candidate.kind,
                  canonicalKey,
                  displayName: candidate.displayName,
                  path: resolve(path),
                },
                observedAt: context.now.toISOString(),
                exists: false,
                facts: {
                  reportOnly: true,
                  primaryDatabaseStatus: "missing",
                  nativeMaintenance: cursorNativeMaintenance,
                  databaseCompanions: cursorDatabaseCompanions,
                },
              });
            }
          }
          continue;
        }

        addDiagnostics({
          severity: "warning",
          code: "RESOURCE_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
      }
    }

    if (this.options.quickInventory !== true) {
      const files = await collectProviderFiles(this.spec.id, context, this.options, probe.root);
      addResources(...files.resources);
      addDiagnostics(...files.diagnostics);
    }

    return { resources, diagnostics };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const quarantinableFile = classifyProviderFile(this.spec.id, context, resource);
    if (quarantinableFile) return quarantinableFile;
    if (this.spec.id === "codex") {
      const database = classifyCodexDatabase(context, resource);
      if (database) return database;
    }
    return classifyProviderOwnership(this.spec.id, context, resource);
  }
}
