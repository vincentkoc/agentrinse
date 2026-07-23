import { randomUUID } from "node:crypto";

import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter, AuditContext } from "../contracts/adapter.js";
import { auditReportSchema, type AuditReport } from "../contracts/report.js";
import { assertAuditRoot } from "./safety.js";

export type RunAuditOptions = {
  home: string;
  config: AgentRinseConfig;
  adapters: AuditAdapter[];
  now?: () => Date;
  signal?: AbortSignal;
};

export async function runAudit(options: RunAuditOptions): Promise<AuditReport> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const home = assertAuditRoot(options.home);
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

    const collection = await adapter.collect(context, probe);
    diagnostics.push(...collection.diagnostics);
    for (const resource of collection.resources) {
      findings.push(await adapter.classify(context, resource));
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
