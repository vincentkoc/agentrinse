import type { AuditContext } from "../contracts/adapter.js";
import type { Finding, RootEvidence } from "../contracts/finding.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { sha256 } from "../core/digest.js";

export function reportOnlyFinding(
  context: AuditContext,
  resource: ResourceSnapshot,
  source: string,
  confidence: Finding["confidence"],
  reasons: Pick<RootEvidence, "code" | "detail">[],
): Finding {
  const observedAt = context.now.toISOString();
  return {
    schemaVersion: 1,
    findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
    auditId: context.auditId,
    observedAt,
    resource: resource.resource,
    state: "protected",
    confidence,
    roots: reasons.map(({ code, detail }) => ({ code, source, observedAt, detail })),
    facts: resource.facts,
    candidateActions: [],
    ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
    warnings: [],
  };
}
