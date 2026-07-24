import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createAuditAdapters } from "../adapters/registry.js";
import { loadConfigForHome } from "../config/load.js";
import type { AuditReport } from "../contracts/report.js";
import { runAudit, type AuditProgressEvent } from "../core/audit.js";
import { redactAuditReport, redactAuditValue } from "../core/redaction.js";
import {
  createCommandEnvelope,
  createCommandEvent,
  jsonDocument,
  ndjsonRecord,
} from "../machine-output.js";
import { renderAudit } from "../output.js";
import { writeJsonAtomic } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";

export type AuditCommandOptions = {
  home: string;
  config?: string;
  json?: boolean;
  ndjson?: boolean;
  redact?: boolean;
  output?: string;
  stateDir?: string;
  now?: () => Date;
  emit?: (output: string) => void;
};

export type AuditCommandResult = {
  report: AuditReport;
  statePath: string;
  output: string;
};

export async function executeAuditCommand(
  options: AuditCommandOptions,
): Promise<AuditCommandResult> {
  if (options.json === true && options.ndjson === true) {
    throw new Error("audit accepts only one of --json or --ndjson");
  }
  if (options.redact === true && options.json !== true && options.ndjson !== true) {
    throw new Error("audit --redact requires --json or --ndjson");
  }

  const clock = options.now ?? (() => new Date());
  const commandId = randomUUID();
  const salt = randomUUID();
  const ndjson: string[] = [];
  let sequence = 0;
  const emitEvent = (event: string, timestamp: string, data?: unknown): void => {
    const value = createCommandEvent({
      event,
      timestamp,
      command: "audit",
      commandId,
      sequence: (sequence += 1),
      ...(data === undefined ? {} : { data }),
    });
    const output = ndjsonRecord(value);
    if (options.emit === undefined) {
      ndjson.push(output);
    } else {
      options.emit(output);
    }
  };

  const home = resolve(options.home);
  const { config } = await loadConfigForHome(home, options.config);
  const startedAt = clock().toISOString();
  if (options.ndjson === true) {
    emitEvent("command.started", startedAt, options.redact === true ? { home: "$HOME" } : { home });
  }
  const report = await runAudit({
    home,
    config,
    adapters: createAuditAdapters(config),
    now: clock,
    ...(options.ndjson === true
      ? {
          onEvent: (event: AuditProgressEvent) => {
            emitEvent(
              event.type,
              event.timestamp,
              options.redact === true ? redactAuditValue(event.data, home, salt) : event.data,
            );
          },
        }
      : {}),
  });
  const statePath = resolve(
    stateLayout(resolveStateRoot(home, options.stateDir)).audits,
    `${report.auditId}.json`,
  );
  await writeJsonAtomic(statePath, report);

  if (options.output !== undefined) {
    await writeJsonAtomic(resolve(options.output), report);
  }

  const selectedReport = options.redact === true ? redactAuditReport(report, salt) : report;
  if (options.ndjson === true) {
    emitEvent("command.completed", report.completedAt, {
      auditId:
        options.redact === true
          ? redactAuditValue({ auditId: report.auditId }, home, salt).auditId
          : report.auditId,
      status:
        report.probes.some((probe) => probe.status === "degraded") || report.diagnostics.length > 0
          ? "degraded"
          : "ok",
      probes: report.probes.length,
      findings: report.findings.length,
    });
  }
  const status =
    report.probes.some((probe) => probe.status === "degraded") || report.diagnostics.length > 0
      ? "degraded"
      : "ok";
  return {
    report,
    statePath,
    output:
      options.ndjson === true
        ? ndjson.join("")
        : options.json === true
          ? jsonDocument(
              createCommandEnvelope({
                command: "audit",
                startedAt: report.startedAt,
                completedAt: report.completedAt,
                status,
                data: selectedReport,
                diagnostics: selectedReport.diagnostics,
              }),
            )
          : renderAudit(report),
  };
}
