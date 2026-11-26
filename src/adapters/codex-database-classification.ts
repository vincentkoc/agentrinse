import type { AuditContext } from "../contracts/adapter.js";
import type { Finding, RootEvidence } from "../contracts/finding.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { databaseIdentitySchema, type DatabaseVacuumAction } from "../contracts/action.js";
import { sha256 } from "../core/digest.js";
import { codexDatabaseContractMatches } from "./codex-database.js";

const DATABASE_RECLAIM_THRESHOLD_BYTES = 512 * 1024 * 1024;
const DATABASE_RECLAIM_RATIO = 0.25;
const DATABASE_BACKUP_TTL_MINUTES = 7 * 24 * 60;

export function classifyCodexDatabase(
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const observedAt = context.now.toISOString();
  const databaseIdentity = databaseIdentitySchema.safeParse(resource.facts.databaseIdentity);
  if (!databaseIdentity.success) return undefined;
  const identity = databaseIdentity.data;
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
  const supported = codexDatabaseContractMatches(identity);
  const worthwhile =
    estimatedReclaimBytes >= DATABASE_RECLAIM_THRESHOLD_BYTES &&
    freePageRatio >= DATABASE_RECLAIM_RATIO;
  const allowed = resource.facts.offlineVacuumAllowed === true;
  const walSafe = identity.wal?.measuredBytes === undefined || identity.wal.measuredBytes === 0;
  const ownerIdle = ownerProcesses?.status === "idle";
  const handlesIdle = openHandles?.status === "idle";
  const roots: RootEvidence[] = [];
  if (!supported) {
    roots.push({
      code: "unsupported-database-contract",
      source: "codex",
      observedAt,
      detail: "The Codex database filename, migration version, or required tables changed.",
    });
  }
  if (!worthwhile) {
    roots.push({
      code: "database-compaction-not-needed",
      source: "codex",
      observedAt,
      detail: "Free pages are below the 512 MiB and 25 percent compaction thresholds.",
    });
  }
  if (!allowed) {
    roots.push({
      code: "offline-vacuum-not-authorized",
      source: "codex",
      observedAt,
      detail: "Re-run the audit with --allow-offline-vacuum to propose this action.",
    });
  }
  if (!walSafe) {
    roots.push({
      code: "database-wal-not-empty",
      source: "codex",
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
      source: "codex",
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
      source: "codex",
      observedAt,
      detail:
        openHandles?.status === "busy"
          ? "A process has the database or a SQLite companion open."
          : (openHandles?.reason ?? "Open database descriptors could not be inspected."),
    });
  }
  const eligible = roots.length === 0;
  const candidateActions: DatabaseVacuumAction[] = eligible
    ? [
        {
          actionId: `database.vacuum:${sha256(JSON.stringify(identity))}`,
          type: "database.vacuum",
          adapter: "codex",
          resourceId: resource.resource.id,
          risk: "experimental",
          description: `Compact Codex ${identity.database} database offline with a retained rollback copy`,
          expectedReclaimBytes: estimatedReclaimBytes,
          backupTtlMinutes: DATABASE_BACKUP_TTL_MINUTES,
          target: identity,
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
    measuredBytes: identity.measuredBytes,
    estimatedReclaimBytes,
    warnings: [],
  };
}
