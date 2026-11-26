import type { AuditContext } from "../../contracts/adapter.js";
import type { Finding } from "../../contracts/finding.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import { cursorNativeMaintenanceFactsSchema } from "../../adapters/cursor-maintenance.js";

export function classifyOwnership(
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const cursorNativeMaintenance = cursorNativeMaintenanceFactsSchema.safeParse(
    resource.facts.nativeMaintenance,
  );
  if (!cursorNativeMaintenance.success) return undefined;
  return reportOnlyFinding(context, resource, "cursor", "unknown", [
    {
      code: "cursor-native-database-maintenance-version-unverified",
      detail:
        "Current Cursor guidance exposes command-palette operations for orphaned agent KV cleanup or user-selected chat deletion, both followed by VACUUM; AgentRinse did not prove the installed Cursor version.",
    },
    {
      code: "provider-owned-report-only",
      detail:
        "Cursor owns its database schema and maintenance commands; AgentRinse does not open or mutate the database.",
    },
  ]);
}
