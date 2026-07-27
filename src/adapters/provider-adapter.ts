import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AuditAdapter, AuditContext, CollectionResult } from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { Finding } from "../contracts/finding.js";
import type { AdapterProbe } from "../contracts/report.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import {
  databaseIdentitySchema,
  providerFileIdentitySchema,
  type DatabaseVacuumAction,
  type ProviderFileQuarantineAction,
} from "../contracts/action.js";
import { sha256 } from "../core/digest.js";
import { measurePath } from "../core/measure.js";
import {
  CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES,
  CLAUDE_CHANGELOG_CACHE_POLICY_ID,
  CLAUDE_CHANGELOG_CACHE_QUARANTINE_TTL_MINUTES,
  CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES,
  CLAUDE_DEBUG_LOG_POLICY_ID,
  CLAUDE_DEBUG_LOG_QUARANTINE_TTL_MINUTES,
  isClaudeChangelogCacheRelativePath,
  isClaudeDebugLogRelativePath,
} from "../core/provider-file-policy.js";
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
import { collectProviderReachability } from "./provider-reachability.js";
import { resolveProviderRoot } from "./provider-root.js";
import type { ProviderSpec } from "./provider-specs.js";

type ClaudeProviderFileQuarantineAction = Extract<
  ProviderFileQuarantineAction,
  { adapter: "claude" }
>;

type ClaudeProviderFileContract = {
  policyId: string;
  minAgeMinutes: number;
  quarantineTtlMinutes: number;
  matchesRelativePath(relativePath: string): boolean;
  description: string;
  rootCode: string;
  rootDetail: string;
  tooRecentDetail: string;
};

const CLAUDE_PROVIDER_FILE_CONTRACTS: readonly ClaudeProviderFileContract[] = [
  {
    policyId: CLAUDE_DEBUG_LOG_POLICY_ID,
    minAgeMinutes: CLAUDE_DEBUG_LOG_MIN_AGE_MINUTES,
    quarantineTtlMinutes: CLAUDE_DEBUG_LOG_QUARANTINE_TTL_MINUTES,
    matchesRelativePath: isClaudeDebugLogRelativePath,
    description: "Quarantine a Claude debug log older than 30 days",
    rootCode: "claude-debug-log-owner-contract",
    rootDetail:
      "Claude documents direct debug logs as disposable application data with no user-facing loss.",
    tooRecentDetail: "The debug log is newer than the 30-day cleanup threshold.",
  },
  {
    policyId: CLAUDE_CHANGELOG_CACHE_POLICY_ID,
    minAgeMinutes: CLAUDE_CHANGELOG_CACHE_MIN_AGE_MINUTES,
    quarantineTtlMinutes: CLAUDE_CHANGELOG_CACHE_QUARANTINE_TTL_MINUTES,
    matchesRelativePath: isClaudeChangelogCacheRelativePath,
    description: "Quarantine the Claude changelog cache after 30 days",
    rootCode: "claude-changelog-cache-owner-contract",
    rootDetail:
      "Claude documents cache/changelog.md as a rebuildable release-notes cache refreshed in the background.",
    tooRecentDetail: "The changelog cache is newer than the 30-day cleanup threshold.",
  },
];

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

    for (const candidate of this.spec.resources) {
      context.signal?.throwIfAborted();
      const path =
        candidate.relativePath === "." ? probe.root : join(probe.root, candidate.relativePath);

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
        const canonicalKey = `${this.id}:${candidate.kind}:${resolve(path)}`;
        const resourceId = `${this.id}:${candidate.kind}:${sha256(canonicalKey)}`;

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

    return { resources, diagnostics };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const observedAt = context.now.toISOString();
    const providerFileIdentity = providerFileIdentitySchema.safeParse(
      resource.facts.providerFileIdentity,
    );
    const claudeProviderFileContract =
      typeof resource.facts.policyId === "string"
        ? CLAUDE_PROVIDER_FILE_CONTRACTS.find(
            (contract) =>
              contract.policyId === resource.facts.policyId &&
              providerFileIdentity.success &&
              contract.matchesRelativePath(providerFileIdentity.data.relativePath),
          )
        : undefined;
    if (
      this.spec.id === "claude" &&
      providerFileIdentity.success &&
      providerFileIdentity.data.provider === "claude" &&
      claudeProviderFileContract !== undefined
    ) {
      const claudeIdentity = {
        ...providerFileIdentity.data,
        provider: "claude" as const,
      };
      const oldEnough =
        context.now.getTime() - claudeIdentity.mtimeMs >=
        claudeProviderFileContract.minAgeMinutes * 60_000;
      const candidateActions: ClaudeProviderFileQuarantineAction[] = oldEnough
        ? [
            {
              actionId: `provider.file-quarantine:${sha256(
                `${claudeProviderFileContract.policyId}:${claudeIdentity.fingerprint}`,
              )}`,
              type: "provider.file-quarantine",
              adapter: "claude",
              resourceId: resource.resource.id,
              policyId: claudeProviderFileContract.policyId,
              risk: "recoverable",
              description: claudeProviderFileContract.description,
              expectedReclaimBytes: 0,
              pendingQuarantineBytes: claudeIdentity.measuredBytes,
              quarantineTtlMinutes: claudeProviderFileContract.quarantineTtlMinutes,
              target: claudeIdentity,
            },
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
            code: claudeProviderFileContract.rootCode,
            source: this.id,
            observedAt,
            detail: claudeProviderFileContract.rootDetail,
          },
          ...(oldEnough
            ? []
            : [
                {
                  code: "provider-file-too-recent",
                  source: this.id,
                  observedAt,
                  detail: claudeProviderFileContract.tooRecentDetail,
                },
              ]),
        ],
        facts: resource.facts,
        candidateActions,
        measuredBytes: claudeIdentity.measuredBytes,
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
