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

export function renderAudit(report: AuditReport): string {
  const lines = [
    "AgentRinse audit (pre-alpha, report-only)",
    "",
    `Synthetic home: ${report.home}`,
    `Adapters: ${report.probes.length}`,
    `Resources: ${report.findings.length}`,
    "",
  ];

  for (const probe of report.probes) {
    lines.push(`${probe.adapter.padEnd(10)} ${probe.status.padEnd(10)} ${probe.detail}`);
  }

  if (report.findings.length > 0) {
    lines.push("", "PROTECTED RESOURCES");
  }

  for (const finding of report.findings) {
    const bytes =
      finding.measuredBytes === undefined
        ? "unknown"
        : formatBytes(finding.measuredBytes);
    lines.push(
      `${bytes.padStart(10)}  ${finding.resource.adapter}/${finding.resource.displayName}`,
    );
  }

  lines.push("", "No cleanup actions are implemented.");
  return `${lines.join("\n")}\n`;
}
