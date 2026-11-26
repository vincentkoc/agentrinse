import type { AuditContext } from "../contracts/adapter.js";
import type { Finding } from "../contracts/finding.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import {
  providerFileIdentitySchema,
  providerFileQuarantineActionSchema,
} from "../contracts/action.js";
import { sha256 } from "../core/digest.js";
import { matchProviderFilePolicy } from "../core/provider-file-policy.js";
import type { ProviderAdapterId } from "./provider-specs.js";

export function classifyProviderFile(
  provider: ProviderAdapterId,
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const observedAt = context.now.toISOString();
  const providerFileIdentity = providerFileIdentitySchema.safeParse(
    resource.facts.providerFileIdentity,
  );
  if (!providerFileIdentity.success || providerFileIdentity.data.provider !== provider)
    return undefined;
  const identity = providerFileIdentity.data;
  const providerFilePolicy = matchProviderFilePolicy(
    provider,
    resource.facts.policyId,
    identity.relativePath,
  );
  if (!providerFilePolicy) return undefined;

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
        source: provider,
        observedAt,
        detail: providerFilePolicy.rootDetail,
      },
      ...(oldEnough
        ? []
        : [
            {
              code: "provider-file-too-recent",
              source: provider,
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
