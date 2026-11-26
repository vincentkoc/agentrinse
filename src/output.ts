import type { CleanupRun } from "./contracts/run.js";
import type { AuditReport } from "./contracts/report.js";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const precision = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${UNITS[unit]}`;
}

export function formatReclaimBytes(bytes: number, actions: readonly { type: string }[]): string {
  const artifacts = actions.filter((action) => action.type === "artifacts.remove").length;
  if (artifacts === 0) return `${bytes} bytes`;
  if (artifacts === actions.length) return `${bytes} logical artifact bytes`;
  return `${bytes} bytes (includes logical artifact bytes)`;
}

export function formatRunReclaimBytes(run: Pick<CleanupRun, "reclaimedBytes" | "actions">): string {
  return formatReclaimBytes(
    run.reclaimedBytes,
    run.actions.filter((action) => (action.reclaimedBytes ?? 0) > 0),
  );
}

export function renderAudit(report: AuditReport): string {
  const actionCount = report.findings.reduce(
    (total, finding) => total + finding.candidateActions.length,
    0,
  );
  const lines = [
    "AgentRinse audit",
    "",
    `Home: ${report.home}`,
    `Adapters: ${report.probes.length}`,
    `Resources: ${report.findings.length}`,
    `Eligible actions: ${actionCount}`,
    "",
  ];

  for (const probe of report.probes) {
    lines.push(`${probe.adapter.padEnd(10)} ${probe.status.padEnd(10)} ${probe.detail}`);
  }

  for (const finding of report.findings) {
    const bytes =
      finding.measuredBytes === undefined ? "unknown" : formatBytes(finding.measuredBytes);
    lines.push(
      `${finding.state.padEnd(10)} ${bytes.padStart(10)}  ${finding.resource.adapter}/${finding.resource.displayName}`,
    );
  }

  lines.push(
    "",
    actionCount === 0
      ? "No cleanup actions are eligible."
      : "Save this audit and create a plan before applying.",
  );
  return `${lines.join("\n")}\n`;
}
