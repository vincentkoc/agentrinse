import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AuditAdapter, AuditContext, CollectionResult } from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { Finding } from "../contracts/finding.js";
import type { AdapterProbe } from "../contracts/report.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import {
  databaseIdentitySchema,
  providerFileQuarantineActionSchema,
  providerFileIdentitySchema,
  type DatabaseVacuumAction,
} from "../contracts/action.js";
import { sha256 } from "../core/digest.js";
import { measurePath } from "../core/measure.js";
import { PROVIDER_FILE_POLICIES } from "../core/provider-file-policy.js";
import type { ReachabilityIndex } from "../core/reachability.js";
import {
  codexDatabaseContractMatches,
  inspectCodexDatabase,
  inspectCodexProcesses,
  inspectDatabaseOpenHandles,
  type CodexDatabaseDependencies,
  type CodexDatabaseInspection,
} from "./codex-database.js";
import { collectClaudeChangelogCache } from "./claude-cache.js";
import { collectClaudeDebugLogs } from "./claude-debug.js";
import {
  claudeNativeRetentionFactsSchema,
  inspectClaudeNativeRetention,
  usesClaudeNativeRetention,
} from "./claude-retention.js";
import {
  copilotNativeMaintenanceFactsSchema,
  copilotNativeMaintenanceFor,
} from "./copilot-maintenance.js";
import {
  cursorNativeMaintenanceFactsSchema,
  cursorNativeMaintenanceFor,
  inspectCursorDatabaseCompanions,
  inspectCursorDatabaseParents,
} from "./cursor-maintenance.js";
import {
  grokOwnerContractFactsSchema,
  inspectGrokOwnerContract,
  type GrokVersionRunner,
} from "./grok-maintenance.js";
import {
  opencodeNativeMaintenanceFactsSchema,
  opencodeNativeMaintenanceFor,
} from "./opencode-maintenance.js";
import { collectProviderReachability } from "./provider-reachability.js";
import { resolveProviderRoot } from "./provider-root.js";
import type { ProviderSpec } from "./provider-specs.js";
import { collectZedRotatedLog } from "./zed-logs.js";

export type ProviderAdapterOptions = {
  root?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  measureBytes: boolean;
  maxEntries: number;
  reachability?: ReachabilityIndex;
  inventoryResources?: boolean;
  allowOfflineVacuum?: boolean;
  databaseDependencies?: CodexDatabaseDependencies;
  inspectDatabase?: (
    path: string,
    dependencies?: CodexDatabaseDependencies,
  ) => Promise<CodexDatabaseInspection>;
  runGrokVersion?: GrokVersionRunner;
};

const DATABASE_RECLAIM_THRESHOLD_BYTES = 512 * 1024 * 1024;
const DATABASE_RECLAIM_RATIO = 0.25;
const DATABASE_BACKUP_TTL_MINUTES = 7 * 24 * 60;

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

  async collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult> {
    if (probe.status !== "available" || probe.root === undefined) {
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
        this.spec.id === "zed" &&
        probe.status === "absent" &&
        this.options.inventoryResources !== false
      ) {
        return collectZedRotatedLog(context, {
          ...(this.options.root === undefined ? {} : { root: this.options.root }),
          ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
          ...(this.options.environment === undefined
            ? {}
            : { environment: this.options.environment }),
        });
      }
      return { resources: [], diagnostics: [] };
    }

    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];

    if (this.options.reachability !== undefined) {
      diagnostics.push(
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
      this.spec.id === "claude"
        ? await inspectClaudeNativeRetention(probe.root, this.options.platform ?? process.platform)
        : undefined;
    if (claudeRetention !== undefined) {
      diagnostics.push(...claudeRetention.diagnostics);
    }
    const grokOwnerContract =
      this.spec.id === "grok"
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
        this.spec.id === "copilot"
          ? copilotNativeMaintenanceFor(candidate.relativePath)
          : undefined;
      const opencodeNativeMaintenance =
        this.spec.id === "opencode"
          ? opencodeNativeMaintenanceFor(candidate.relativePath)
          : undefined;
      const cursorNativeMaintenance =
        this.spec.id === "cursor" ? cursorNativeMaintenanceFor(candidate.relativePath) : undefined;
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
          diagnostics.push({
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
          diagnostics.push({
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

        resources.push({
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
              resources.push({
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

        diagnostics.push({
          severity: "warning",
          code: "RESOURCE_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
      }
    }

    if (this.spec.id === "claude") {
      const debugLogs = await collectClaudeDebugLogs(context, probe.root, this.options.maxEntries);
      const changelogCache = await collectClaudeChangelogCache(context, probe.root);
      resources.push(...debugLogs.resources);
      resources.push(...changelogCache.resources);
      diagnostics.push(...debugLogs.diagnostics);
      diagnostics.push(...changelogCache.diagnostics);
    }
    if (this.spec.id === "zed") {
      const rotatedLog = await collectZedRotatedLog(context, {
        ...(this.options.root === undefined ? {} : { root: this.options.root }),
        ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
        ...(this.options.environment === undefined
          ? {}
          : { environment: this.options.environment }),
      });
      resources.push(...rotatedLog.resources);
      diagnostics.push(...rotatedLog.diagnostics);
    }

    return { resources, diagnostics };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const observedAt = context.now.toISOString();
    const providerFileIdentity = providerFileIdentitySchema.safeParse(
      resource.facts.providerFileIdentity,
    );
    const claudeNativeRetention = claudeNativeRetentionFactsSchema.safeParse(
      resource.facts.nativeRetention,
    );
    const copilotNativeMaintenance = copilotNativeMaintenanceFactsSchema.safeParse(
      resource.facts.nativeMaintenance,
    );
    const opencodeNativeMaintenance = opencodeNativeMaintenanceFactsSchema.safeParse(
      resource.facts.nativeMaintenance,
    );
    const cursorNativeMaintenance = cursorNativeMaintenanceFactsSchema.safeParse(
      resource.facts.nativeMaintenance,
    );
    const grokOwnerContract = grokOwnerContractFactsSchema.safeParse(resource.facts.ownerContract);
    const providerFilePolicy =
      typeof resource.facts.policyId === "string"
        ? PROVIDER_FILE_POLICIES.find(
            (policy) =>
              policy.id === resource.facts.policyId &&
              providerFileIdentity.success &&
              policy.matchesRelativePath(providerFileIdentity.data.relativePath),
          )
        : undefined;
    if (
      providerFileIdentity.success &&
      providerFileIdentity.data.provider === this.spec.id &&
      providerFilePolicy?.provider === this.spec.id
    ) {
      const identity = providerFileIdentity.data;
      const oldEnough =
        context.now.getTime() - identity.mtimeMs >= providerFilePolicy.minAgeMinutes * 60_000;
      const candidateActions = oldEnough
        ? [
            providerFileQuarantineActionSchema.parse({
              actionId: `provider.file-quarantine:${sha256(
                `${providerFilePolicy.id}:${identity.fingerprint}`,
              )}`,
              type: "provider.file-quarantine",
              adapter: providerFilePolicy.provider,
              resourceId: resource.resource.id,
              policyId: providerFilePolicy.id,
              risk: "recoverable",
              description: providerFilePolicy.description,
              expectedReclaimBytes: 0,
              pendingQuarantineBytes: identity.measuredBytes,
              quarantineTtlMinutes: providerFilePolicy.quarantineTtlMinutes,
              target: identity,
            }),
          ]
        : [];
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: oldEnough ? "eligible" : "protected",
        confidence: "certain",
        roots: [
          {
            code: providerFilePolicy.rootCode,
            source: this.id,
            observedAt,
            detail: providerFilePolicy.rootDetail,
          },
          ...(oldEnough
            ? []
            : [
                {
                  code: "provider-file-too-recent",
                  source: this.id,
                  observedAt,
                  detail: providerFilePolicy.tooRecentDetail,
                },
              ]),
        ],
        facts: resource.facts,
        candidateActions,
        measuredBytes: identity.measuredBytes,
        estimatedReclaimBytes: 0,
        warnings: [],
      };
    }
    const databaseIdentity = databaseIdentitySchema.safeParse(resource.facts.databaseIdentity);
    if (this.spec.id === "codex" && databaseIdentity.success) {
      const estimatedReclaimBytes =
        typeof resource.facts.estimatedReclaimBytes === "number"
          ? resource.facts.estimatedReclaimBytes
          : 0;
      const freePageRatio =
        typeof resource.facts.freePageRatio === "number" ? resource.facts.freePageRatio : 0;
      const openHandles = resource.facts.openHandles as
        | { status?: string; reason?: string }
        | undefined;
      const ownerProcesses = resource.facts.ownerProcesses as
        | { status?: string; reason?: string }
        | undefined;
      const supported = codexDatabaseContractMatches(databaseIdentity.data);
      const worthwhile =
        estimatedReclaimBytes >= DATABASE_RECLAIM_THRESHOLD_BYTES &&
        freePageRatio >= DATABASE_RECLAIM_RATIO;
      const allowed = resource.facts.offlineVacuumAllowed === true;
      const walSafe =
        databaseIdentity.data.wal?.measuredBytes === undefined ||
        databaseIdentity.data.wal.measuredBytes === 0;
      const ownerIdle = ownerProcesses?.status === "idle";
      const handlesIdle = openHandles?.status === "idle";
      const eligible = supported && worthwhile && allowed && walSafe && ownerIdle && handlesIdle;
      const roots = [];
      if (!supported) {
        roots.push({
          code: "unsupported-database-contract",
          source: this.id,
          observedAt,
          detail: "The Codex database filename, migration version, or required tables changed.",
        });
      }
      if (!worthwhile) {
        roots.push({
          code: "database-compaction-not-needed",
          source: this.id,
          observedAt,
          detail: "Free pages are below the 512 MiB and 25 percent compaction thresholds.",
        });
      }
      if (!allowed) {
        roots.push({
          code: "offline-vacuum-not-authorized",
          source: this.id,
          observedAt,
          detail: "Re-run the audit with --allow-offline-vacuum to propose this action.",
        });
      }
      if (!walSafe) {
        roots.push({
          code: "database-wal-not-empty",
          source: this.id,
          observedAt,
          detail: "The WAL contains data and must be checkpointed by Codex before compaction.",
        });
      }
      if (!ownerIdle) {
        roots.push({
          code:
            ownerProcesses?.status === "busy"
              ? "provider-process-active"
              : "provider-process-state-unknown",
          source: this.id,
          observedAt,
          detail:
            ownerProcesses?.status === "busy"
              ? "A Codex CLI, desktop, or app-server process is active."
              : (ownerProcesses?.reason ?? "Codex process state could not be proven."),
        });
      }
      if (!handlesIdle) {
        roots.push({
          code:
            openHandles?.status === "busy"
              ? "database-open-descriptor"
              : "database-descriptor-state-unknown",
          source: this.id,
          observedAt,
          detail:
            openHandles?.status === "busy"
              ? "A process has the database or a SQLite companion open."
              : (openHandles?.reason ?? "Open database descriptors could not be inspected."),
        });
      }
      const candidateActions: DatabaseVacuumAction[] = eligible
        ? [
            {
              actionId: `database.vacuum:${sha256(JSON.stringify(databaseIdentity.data))}`,
              type: "database.vacuum",
              adapter: "codex",
              resourceId: resource.resource.id,
              risk: "experimental",
              description: `Compact Codex ${databaseIdentity.data.database} database offline with a retained rollback copy`,
              expectedReclaimBytes: estimatedReclaimBytes,
              backupTtlMinutes: DATABASE_BACKUP_TTL_MINUTES,
              target: databaseIdentity.data,
            },
          ]
        : [];
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: eligible ? "eligible" : "protected",
        confidence: supported ? "certain" : "unknown",
        roots,
        facts: resource.facts,
        candidateActions,
        measuredBytes: databaseIdentity.data.measuredBytes,
        estimatedReclaimBytes,
        warnings: [],
      };
    }
    if (this.spec.id === "claude" && claudeNativeRetention.success) {
      const uncertain = !["missing", "valid"].includes(
        claudeNativeRetention.data.userSettingsStatus,
      );
      const configuredDays = claudeNativeRetention.data.userConfiguredDays;
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: "protected",
        confidence: uncertain ? "unknown" : "high",
        roots: [
          {
            code: uncertain
              ? "claude-native-retention-uncertain"
              : "claude-native-retention-expected",
            source: this.id,
            observedAt,
            detail: uncertain
              ? "Claude user settings could not be validated; Claude may pause native cleanup unless managed settings provide cleanupPeriodDays."
              : configuredDays === undefined
                ? "Claude documents a 30-day startup retention sweep; higher-precedence settings were not resolved."
                : `Claude user settings declare a ${configuredDays}-day startup retention sweep; higher-precedence settings were not resolved.`,
          },
          {
            code: "provider-owned-report-only",
            source: this.id,
            observedAt,
            detail: "Claude owns this retention sweep; AgentRinse does not mutate the resource.",
          },
        ],
        facts: resource.facts,
        candidateActions: [],
        ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
        warnings: [],
      };
    }
    if (this.spec.id === "copilot" && copilotNativeMaintenance.success) {
      const detail =
        copilotNativeMaintenance.data.kind === "session-prune"
          ? "Current Copilot CLI documents local-only session pruning with dry-run support; AgentRinse did not probe the installed CLI version."
          : "Copilot CLI 1.0.52 introduced startup pruning for direct process logs older than seven days or beyond the newest 50; AgentRinse did not probe the installed CLI version.";
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: "protected",
        confidence: "unknown",
        roots: [
          {
            code: "copilot-native-maintenance-version-unverified",
            source: this.id,
            observedAt,
            detail,
          },
          {
            code: "provider-owned-report-only",
            source: this.id,
            observedAt,
            detail: "Copilot owns this maintenance path; AgentRinse does not mutate the resource.",
          },
        ],
        facts: resource.facts,
        candidateActions: [],
        ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
        warnings: [],
      };
    }
    if (this.spec.id === "opencode" && opencodeNativeMaintenance.success) {
      const detail =
        opencodeNativeMaintenance.data.kind === "snapshot-gc"
          ? "OpenCode 1.18.9 schedules snapshot Git garbage collection after one minute and hourly, pruning objects older than seven days; AgentRinse did not probe the installed version."
          : "OpenCode 1.18.9 appends server logs to opencode.log without a server-log retention sweep; the desktop application's separate seven-day log cleanup does not cover this directory.";
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: "protected",
        confidence: "unknown",
        roots: [
          {
            code:
              opencodeNativeMaintenance.data.kind === "snapshot-gc"
                ? "opencode-native-snapshot-gc-version-unverified"
                : "opencode-server-log-retention-version-unverified",
            source: this.id,
            observedAt,
            detail,
          },
          {
            code: "provider-owned-report-only",
            source: this.id,
            observedAt,
            detail: "OpenCode owns this maintenance path; AgentRinse does not mutate the resource.",
          },
        ],
        facts: resource.facts,
        candidateActions: [],
        ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
        warnings: [],
      };
    }
    if (this.spec.id === "cursor" && cursorNativeMaintenance.success) {
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: "protected",
        confidence: "unknown",
        roots: [
          {
            code: "cursor-native-database-maintenance-version-unverified",
            source: this.id,
            observedAt,
            detail:
              "Current Cursor guidance exposes command-palette operations for orphaned agent KV cleanup or user-selected chat deletion, both followed by VACUUM; AgentRinse did not prove the installed Cursor version.",
          },
          {
            code: "provider-owned-report-only",
            source: this.id,
            observedAt,
            detail:
              "Cursor owns its database schema and maintenance commands; AgentRinse does not open or mutate the database.",
          },
        ],
        facts: resource.facts,
        candidateActions: [],
        ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
        warnings: [],
      };
    }
    if (this.spec.id === "grok" && grokOwnerContract.success) {
      const versionStatus = grokOwnerContract.data.installedVersionStatus;
      const executableStatus = grokOwnerContract.data.ownerExecutableStatus;
      const exact = versionStatus === "exact";
      const detail = exact
        ? "The installed Grok version and build revision match the inspected source snapshot. Grok runs its memory GC during session initialization, but exposes no tagged, user-invokable cleanup contract that AgentRinse can bind and revalidate."
        : versionStatus === "version-mismatch"
          ? `Installed Grok ${grokOwnerContract.data.installedVersion} does not match inspected source version ${grokOwnerContract.data.sourceVersion}; only the owner root was inventoried.`
          : versionStatus === "revision-mismatch"
            ? `Installed Grok build revision ${grokOwnerContract.data.installedRevision} does not match the inspected source revisions; only the owner root was inventoried.`
            : versionStatus === "unparseable"
              ? "The installed Grok version output did not match the documented format; only the owner root was inventoried."
              : executableStatus === "unsafe"
                ? "The canonical Grok executable escapes or does not resolve to a file inside the audited owner root; only the owner root was inventoried."
                : executableStatus === "unexecutable"
                  ? "The canonical Grok executable is not executable; only the owner root was inventoried."
                  : executableStatus === "unreadable"
                    ? "The canonical Grok executable could not be inspected; only the owner root was inventoried."
                    : executableStatus === "missing"
                      ? "The audited owner root has no canonical Grok executable; only the owner root was inventoried."
                      : "The bound Grok executable version could not be inspected; only the owner root was inventoried.";
      return {
        schemaVersion: 1,
        findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
        auditId: context.auditId,
        observedAt,
        resource: resource.resource,
        state: "protected",
        confidence: exact ? "high" : "unknown",
        roots: [
          {
            code: "grok-cleanup-owner-contract-unavailable",
            source: this.id,
            observedAt,
            detail,
          },
          {
            code: "provider-owned-report-only",
            source: this.id,
            observedAt,
            detail:
              "Grok owns sessions, memory, logs, worktrees, plugins, credentials, configuration, and runtime assets; AgentRinse does not mutate them.",
          },
        ],
        facts: resource.facts,
        candidateActions: [],
        ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
        warnings: [],
      };
    }
    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state: "protected",
      confidence: "certain",
      roots: [
        {
          code: "provider-owned-report-only",
          source: this.id,
          observedAt,
          detail: "This adapter inventories provider state but does not clean it.",
        },
      ],
      facts: resource.facts,
      candidateActions: [],
      ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
      warnings: [],
    };
  }
}
