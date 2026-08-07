import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { createAuditAdapters } from "../adapters/registry.js";
import { PROVIDER_IDS, type ProviderAdapterId } from "../adapters/provider-specs.js";
import { loadConfigForHome } from "../config/load.js";
import type { AgentRinseConfig } from "../config/schema.js";
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
  noState?: boolean;
  providers?: string;
  allowOfflineVacuum?: boolean;
  now?: () => Date;
  emit?: (output: string) => void;
};

export type AuditCommandResult = {
  report: AuditReport;
  statePath?: string;
  output: string;
};

const PROVIDER_ID_SET = new Set<string>(PROVIDER_IDS);
const NON_PROVIDER_IDS = new Set(["artifacts", "docker", "git", "runtime"]);

export function parseAuditProviders(value?: string): ProviderAdapterId[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0) {
    throw new Error("audit --providers requires a non-empty comma-separated provider list");
  }

  const providers: ProviderAdapterId[] = [];
  const seen = new Set<string>();
  for (const id of value.split(",")) {
    if (id.length === 0) {
      throw new Error("audit --providers contains an empty provider ID");
    }
    if (id.trim() !== id) {
      throw new Error("audit --providers accepts exact provider IDs without whitespace");
    }
    if (NON_PROVIDER_IDS.has(id)) {
      throw new Error(`audit --providers accepts provider IDs only; got ${id}`);
    }
    if (!PROVIDER_ID_SET.has(id)) {
      throw new Error(`audit --providers contains unknown provider: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`audit --providers contains duplicate provider: ${id}`);
    }
    seen.add(id);
    providers.push(id as ProviderAdapterId);
  }
  return providers;
}

function assertAbsoluteSelectedProviderRoots(
  config: AgentRinseConfig,
  providers: readonly ProviderAdapterId[],
): void {
  for (const id of providers) {
    const root = config.adapters[id]?.root;
    if (root !== undefined && !isAbsolute(root)) {
      throw new Error(`audit --providers requires an absolute configured root for ${id}`);
    }
  }
}

function withoutCandidateActions(report: AuditReport): AuditReport {
  return {
    ...report,
    findings: report.findings.map((finding) => ({
      ...finding,
      candidateActions: [],
    })),
  };
}

export async function executeAuditCommand(
  options: AuditCommandOptions,
): Promise<AuditCommandResult> {
  if (options.json === true && options.ndjson === true) {
    throw new Error("audit accepts only one of --json or --ndjson");
  }
  if (options.redact === true && options.json !== true && options.ndjson !== true) {
    throw new Error("audit --redact requires --json or --ndjson");
  }
  if (options.noState === true && options.output !== undefined) {
    throw new Error("audit --no-state does not accept --output");
  }
  if (options.noState === true && options.stateDir !== undefined) {
    throw new Error("audit --no-state does not accept --state-dir");
  }
  if (options.noState === true && options.json !== true && options.ndjson !== true) {
    throw new Error("audit --no-state requires --json or --ndjson");
  }
  const providers = parseAuditProviders(options.providers);
  if (providers !== undefined && options.noState !== true) {
    throw new Error("audit --providers requires --no-state");
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
  if (providers !== undefined) {
    assertAbsoluteSelectedProviderRoots(config, providers);
  }
  const startedAt = clock().toISOString();
  if (options.ndjson === true) {
    emitEvent("command.started", startedAt, options.redact === true ? { home: "$HOME" } : { home });
  }
  try {
    const discoveredReport = await runAudit({
      home,
      config,
      adapters: createAuditAdapters(config, process.platform, {
        allowOfflineVacuum: options.allowOfflineVacuum ?? false,
        ...(providers === undefined ? {} : { providers }),
      }),
      now: clock,
      ...(options.ndjson === true
        ? {
            onEvent: (event: AuditProgressEvent) => {
              const eventData =
                providers !== undefined && event.type === "finding.completed"
                  ? { ...event.data, candidateActions: [] }
                  : event.data;
              emitEvent(
                event.type,
                event.timestamp,
                options.redact === true ? redactAuditValue(eventData, home, salt) : eventData,
              );
            },
          }
        : {}),
    });
    const report =
      providers === undefined ? discoveredReport : withoutCandidateActions(discoveredReport);
    let statePath: string | undefined;
    if (options.noState !== true) {
      const layout = stateLayout(resolveStateRoot(home, options.stateDir));
      statePath = resolve(layout.audits, `${report.auditId}.json`);
      await writeJsonAtomic(statePath, report, {
        privateDirectories: [layout.root, layout.audits],
      });
    }

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
          report.probes.some((probe) => probe.status === "degraded") ||
          report.diagnostics.length > 0
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
      ...(statePath === undefined ? {} : { statePath }),
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
  } catch (error) {
    if (options.ndjson === true) {
      const data = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      emitEvent(
        "command.completed",
        clock().toISOString(),
        options.redact === true ? redactAuditValue(data, home, salt) : data,
      );
    }
    throw error;
  }
}
