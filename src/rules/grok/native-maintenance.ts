import type { AuditContext } from "../../contracts/adapter.js";
import type { Finding } from "../../contracts/finding.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import {
  describeGrokOwnerContract,
  grokOwnerContractFactsSchema,
} from "../../adapters/grok-maintenance.js";

export function classifyOwnership(
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const grokOwnerContract = grokOwnerContractFactsSchema.safeParse(resource.facts.ownerContract);
  if (!grokOwnerContract.success) return undefined;
  const facts = grokOwnerContract.data;
  const detail = describeGrokOwnerContract(facts);
  const exact = facts.installedVersionStatus === "exact";
  return reportOnlyFinding(context, resource, "grok", exact ? "high" : "unknown", [
    {
      code: "grok-cleanup-owner-contract-unavailable",
      detail,
    },
    {
      code: "provider-owned-report-only",
      detail:
        "Grok owns sessions, memory, logs, worktrees, plugins, credentials, configuration, and runtime assets; AgentRinse does not mutate them.",
    },
  ]);
}
