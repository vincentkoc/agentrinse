import type { AuditContext } from "../contracts/adapter.js";
import type { Finding } from "../contracts/finding.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import type { ProviderAdapterId } from "./provider-specs.js";
import { reportOnlyFinding } from "./report-only-finding.js";
import { openClawProtection } from "./openclaw.js";
import { claudeNativeRetentionFactsSchema } from "./claude-retention.js";
import { copilotNativeMaintenanceFactsSchema } from "./copilot-maintenance.js";
import { opencodeNativeMaintenanceFactsSchema } from "./opencode-maintenance.js";
import { cursorNativeMaintenanceFactsSchema } from "./cursor-maintenance.js";
import { grokOwnerContractFactsSchema } from "./grok-maintenance.js";

export function classifyProviderOwnership(
  provider: ProviderAdapterId,
  context: AuditContext,
  resource: ResourceSnapshot,
): Finding {
  switch (provider) {
    case "claude": {
      const claudeNativeRetention = claudeNativeRetentionFactsSchema.safeParse(
        resource.facts.nativeRetention,
      );
      if (!claudeNativeRetention.success) break;
      const uncertain = !["missing", "valid"].includes(
        claudeNativeRetention.data.userSettingsStatus,
      );
      const configuredDays = claudeNativeRetention.data.userConfiguredDays;
      return reportOnlyFinding(context, resource, provider, uncertain ? "unknown" : "high", [
        {
          code: uncertain
            ? "claude-native-retention-uncertain"
            : "claude-native-retention-expected",

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
    case "copilot": {
      const copilotNativeMaintenance = copilotNativeMaintenanceFactsSchema.safeParse(
        resource.facts.nativeMaintenance,
      );
      if (!copilotNativeMaintenance.success) break;
      const detail =
        copilotNativeMaintenance.data.kind === "session-prune"
          ? "Current Copilot CLI documents local-only session pruning with dry-run support; AgentRinse did not probe the installed CLI version."
          : "Copilot CLI 1.0.52 introduced startup pruning for direct process logs older than seven days or beyond the newest 50; AgentRinse did not probe the installed CLI version.";
      return reportOnlyFinding(context, resource, provider, "unknown", [
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
    case "opencode": {
      const opencodeNativeMaintenance = opencodeNativeMaintenanceFactsSchema.safeParse(
        resource.facts.nativeMaintenance,
      );
      if (!opencodeNativeMaintenance.success) break;
      const detail =
        opencodeNativeMaintenance.data.kind === "snapshot-gc"
          ? "OpenCode 1.18.9 schedules snapshot Git garbage collection after one minute and hourly, pruning objects older than seven days; AgentRinse did not probe the installed version."
          : "OpenCode 1.18.9 appends server logs to opencode.log without a server-log retention sweep; the desktop application's separate seven-day log cleanup does not cover this directory.";
      return reportOnlyFinding(context, resource, provider, "unknown", [
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
    case "cursor": {
      const cursorNativeMaintenance = cursorNativeMaintenanceFactsSchema.safeParse(
        resource.facts.nativeMaintenance,
      );
      if (!cursorNativeMaintenance.success) break;
      return reportOnlyFinding(context, resource, provider, "unknown", [
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
    case "grok": {
      const grokOwnerContract = grokOwnerContractFactsSchema.safeParse(
        resource.facts.ownerContract,
      );
      if (!grokOwnerContract.success) break;
      const versionStatus = grokOwnerContract.data.installedVersionStatus;
      const executableStatus = grokOwnerContract.data.ownerExecutableStatus;
      const exact = versionStatus === "exact";
      const detail = exact
        ? "The installed Grok version and build revision match the inspected source snapshot. Grok runs its memory GC during session initialization, but exposes no tagged, user-invokable cleanup contract that AgentRinse can bind and revalidate."
        : versionStatus === "version-mismatch"
          ? `Installed Grok ${grokOwnerContract.data.installedVersion} does not match inspected source version ${grokOwnerContract.data.sourceVersion}; only the owner root was inventoried.`
          : versionStatus === "revision-mismatch"
            ? `Installed Grok build revision ${grokOwnerContract.data.installedRevision} does not match the inspected source revisions; only the owner root was inventoried.`
            : versionStatus === "unparseable"
              ? "The installed Grok version output did not match the documented format; only the owner root was inventoried."
              : executableStatus === "unsafe"
                ? "The canonical Grok executable escapes or does not resolve to a file inside the audited owner root; only the owner root was inventoried."
                : executableStatus === "unexecutable"
                  ? "The canonical Grok executable is not executable; only the owner root was inventoried."
                  : executableStatus === "unreadable"
                    ? "The canonical Grok executable could not be inspected; only the owner root was inventoried."
                    : executableStatus === "missing"
                      ? "The audited owner root has no canonical Grok executable; only the owner root was inventoried."
                      : "The bound Grok executable version could not be inspected; only the owner root was inventoried.";
      return reportOnlyFinding(context, resource, provider, exact ? "high" : "unknown", [
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
  }
  const protection = provider === "openclaw" ? openClawProtection(resource) : undefined;
  return reportOnlyFinding(context, resource, provider, "certain", [
    {
      code: protection?.code ?? "provider-owned-report-only",

      detail:
        protection?.detail ?? "This adapter inventories provider state but does not clean it.",
    },
  ]);
}
