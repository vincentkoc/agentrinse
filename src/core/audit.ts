import { randomUUID } from "node:crypto";

import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter, AuditContext } from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { Finding } from "../contracts/finding.js";
import { auditReportSchema, type AuditReport } from "../contracts/report.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { assertAuditRoot } from "./safety.js";

export type RunAuditOptions = {
  home: string;
  config: AgentRinseConfig;
  adapters: AuditAdapter[];
  now?: () => Date;
  signal?: AbortSignal;
  onEvent?: (event: AuditProgressEvent) => void;
};

export type AuditProgressEvent =
  | {
      type: "adapter.probed";
      timestamp: string;
      data: AuditReport["probes"][number];
    }
  | {
      type: "diagnostic.reported";
      timestamp: string;
      data: Diagnostic;
    }
  | {
      type: "resource.discovered";
      timestamp: string;
      data: ResourceSnapshot;
    }
  | {
      type: "finding.completed";
      timestamp: string;
      data: Finding;
    };

export async function runAudit(options: RunAuditOptions): Promise<AuditReport> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const home = await assertAuditRoot(options.home);
  const context: AuditContext = {
    home,
    now: startedAt,
    auditId: randomUUID(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const probes = [];
  const findings = [];
  const diagnostics = [];

  for (const adapter of options.adapters) {
    options.signal?.throwIfAborted();
    const probe = await adapter.probe(context);
    probes.push(probe);
    diagnostics.push(...probe.diagnostics);
    options.onEvent?.({
      type: "adapter.probed",
      timestamp: clock().toISOString(),
      data: probe,
    });
    for (const diagnostic of probe.diagnostics) {
      options.onEvent?.({
        type: "diagnostic.reported",
        timestamp: clock().toISOString(),
        data: diagnostic,
      });
    }

    const collection = await adapter.collect(context, probe);
    diagnostics.push(...collection.diagnostics);
    for (const diagnostic of collection.diagnostics) {
      options.onEvent?.({
        type: "diagnostic.reported",
        timestamp: clock().toISOString(),
        data: diagnostic,
      });
    }
    for (const resource of collection.resources) {
      options.onEvent?.({
        type: "resource.discovered",
        timestamp: clock().toISOString(),
        data: resource,
      });
      const finding = await adapter.classify(context, resource);
      findings.push(finding);
      options.onEvent?.({
        type: "finding.completed",
        timestamp: clock().toISOString(),
        data: finding,
      });
    }
  }

  probes.sort((left, right) => left.adapter.localeCompare(right.adapter));
  findings.sort((left, right) => left.resource.id.localeCompare(right.resource.id));

  return auditReportSchema.parse({
    schemaVersion: 1,
    auditId: context.auditId,
    startedAt: startedAt.toISOString(),
    completedAt: clock().toISOString(),
    home,
    probes,
    findings,
    diagnostics,
  });
}
