import type { AuditContext } from "../../contracts/adapter.js";
import type { Finding } from "../../contracts/finding.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { reportOnlyFinding } from "../../adapters/report-only-finding.js";
import { claudeNativeRetentionFactsSchema } from "../../adapters/claude-retention.js";

export function classifyOwnership(
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding | undefined {
  const claudeNativeRetention = claudeNativeRetentionFactsSchema.safeParse(
    resource.facts.nativeRetention,
  );
  if (!claudeNativeRetention.success) return undefined;
  const uncertain = !["missing", "valid"].includes(claudeNativeRetention.data.userSettingsStatus);
  const configuredDays = claudeNativeRetention.data.userConfiguredDays;
  return reportOnlyFinding(context, resource, "claude", uncertain ? "unknown" : "high", [
    {
      code: uncertain ? "claude-native-retention-uncertain" : "claude-native-retention-expected",
      detail: uncertain
        ? "Claude user settings could not be validated; Claude may pause native cleanup unless managed settings provide cleanupPeriodDays."
        : configuredDays === undefined
          ? "Claude documents a 30-day startup retention sweep; higher-precedence settings were not resolved."
          : `Claude user settings declare a ${configuredDays}-day startup retention sweep; higher-precedence settings were not resolved.`,
    },
    {
      code: "provider-owned-report-only",
      detail: "Claude owns this retention sweep; AgentRinse does not mutate the resource.",
    },
  ]);
}
