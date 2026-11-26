import type { AuditContext } from "../../contracts/adapter.js";
import type { Finding } from "../../contracts/finding.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import { copilotNativeMaintenanceFactsSchema } from "../../adapters/copilot-maintenance.js";

export function classifyOwnership(
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const copilotNativeMaintenance = copilotNativeMaintenanceFactsSchema.safeParse(
    resource.facts.nativeMaintenance,
  );
  if (!copilotNativeMaintenance.success) return undefined;
  const detail =
    copilotNativeMaintenance.data.kind === "session-prune"
      ? "Current Copilot CLI documents local-only session pruning with dry-run support; AgentRinse did not probe the installed CLI version."
      : "Copilot CLI 1.0.52 introduced startup pruning for direct process logs older than seven days or beyond the newest 50; AgentRinse did not probe the installed CLI version.";
  return reportOnlyFinding(context, resource, "copilot", "unknown", [
    {
      code: "copilot-native-maintenance-version-unverified",
      detail,
    },
    {
      code: "provider-owned-report-only",
      detail: "Copilot owns this maintenance path; AgentRinse does not mutate the resource.",
    },
  ]);
}
