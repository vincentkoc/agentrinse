import { providerFilePolicy, type ProviderRules } from "../config/rule-options.js";
import type { AuditContext } from "../contracts/adapter.js";
import type { Finding } from "../contracts/finding.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import {
  providerFileIdentitySchema,
  providerFileQuarantineActionSchema,
} from "../contracts/action.js";
import { sha256 } from "../core/digest.js";
import { matchProviderFilePolicy } from "../rules/file-rule.js";
import type { ProviderAdapterId } from "./provider-specs.js";

export function classifyProviderFile(
  provider: ProviderAdapterId,
  context: AuditContext,
  resource: ResourceSnapshot,
  rules?: ProviderRules,
): Finding | undefined {
  const observedAt = context.now.toISOString();
  const providerFileIdentity = providerFileIdentitySchema.safeParse(
    resource.facts.providerFileIdentity,
  );
  if (!providerFileIdentity.success || providerFileIdentity.data.provider !== provider)
    return undefined;
  const identity = providerFileIdentity.data;
  const rule = matchProviderFilePolicy(provider, resource.facts.policyId, identity.relativePath);
  if (!rule) return undefined;
  const policy = providerFilePolicy(rule, rules);

  const oldEnough = context.now.getTime() - identity.mtimeMs >= policy.minAgeMinutes * 60_000;
  const eligible = policy.enabled && oldEnough;
  const candidateActions = eligible
    ? [
        providerFileQuarantineActionSchema.parse({
          actionId: `provider.file-quarantine:${sha256(`${rule.id}:${identity.fingerprint}`)}`,
          type: "provider.file-quarantine",
          adapter: rule.provider,
          resourceId: resource.resource.id,
          policyId: rule.id,
          risk: "recoverable",
          description:
            policy.minAgeMinutes === rule.minAgeMinutes
              ? rule.description
              : `Quarantine ${rule.displayName} after ${policy.minAgeMinutes} minutes`,
          expectedReclaimBytes: 0,
          pendingQuarantineBytes: identity.measuredBytes,
          quarantineTtlMinutes: policy.quarantineTtlMinutes,
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
    state: eligible ? "eligible" : "protected",
    confidence: "certain",
    roots: [
      {
        code: rule.rootCode,
        source: provider,
        observedAt,
        detail: rule.rootDetail,
      },
      ...(!policy.enabled
        ? [
            {
              code: "provider-file-rule-disabled",
              source: provider,
              observedAt,
              detail: "Quarantine for this rule is disabled by configuration.",
            },
          ]
        : []),
      ...(oldEnough
        ? []
        : [
            {
              code: "provider-file-too-recent",
              source: provider,
              observedAt,
              detail:
                policy.minAgeMinutes === rule.minAgeMinutes
                  ? rule.tooRecentDetail
                  : `The file is newer than the configured ${policy.minAgeMinutes}-minute threshold.`,
            },
          ]),
    ],
    facts: rules?.[rule.id]
      ? {
          ...resource.facts,
          minAgeMinutes: policy.minAgeMinutes,
          quarantineTtlMinutes: policy.quarantineTtlMinutes,
          ruleEnabled: policy.enabled,
        }
      : resource.facts,
    candidateActions,
    measuredBytes: identity.measuredBytes,
    estimatedReclaimBytes: 0,
    warnings: [],
  };
}
