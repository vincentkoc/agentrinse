import type { AuditContext } from "../../contracts/adapter.js";
import type { Finding } from "../../contracts/finding.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import { opencodeNativeMaintenanceFactsSchema } from "../../adapters/opencode-maintenance.js";

export function classifyOwnership(
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const opencodeNativeMaintenance = opencodeNativeMaintenanceFactsSchema.safeParse(
    resource.facts.nativeMaintenance,
  );
  if (!opencodeNativeMaintenance.success) return undefined;
  const detail =
    opencodeNativeMaintenance.data.kind === "snapshot-gc"
      ? "OpenCode 1.18.9 schedules snapshot Git garbage collection after one minute and hourly, pruning objects older than seven days; AgentRinse did not probe the installed version."
      : "OpenCode 1.18.9 appends server logs to opencode.log without a server-log retention sweep; the desktop application's separate seven-day log cleanup does not cover this directory.";
  return reportOnlyFinding(context, resource, "opencode", "unknown", [
    {
      code:
        opencodeNativeMaintenance.data.kind === "snapshot-gc"
          ? "opencode-native-snapshot-gc-version-unverified"
          : "opencode-server-log-retention-version-unverified",
      detail,
    },
    {
      code: "provider-owned-report-only",
      detail: "OpenCode owns this maintenance path; AgentRinse does not mutate the resource.",
    },
  ]);
}
