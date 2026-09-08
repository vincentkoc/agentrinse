import { randomUUID } from "node:crypto";

import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter, AuditContext } from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { Finding } from "../contracts/finding.js";
import { auditReportSchema, type AuditReport } from "../contracts/report.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { assertAuditRoot } from "./safety.js";

export type AuditPhase = "probe" | "collect" | "classify";

export type RunAuditOptions = {
  home: string;
  config: AgentRinseConfig;
  adapters: AuditAdapter[];
  now?: () => Date;
  monotonicNow?: () => number;
  signal?: AbortSignal;
  phaseTimeoutMs?: number;
  onEvent?: (event: AuditProgressEvent) => void;
};

export type AuditProgressEvent =
  | {
      type: "phase.started";
      timestamp: string;
      data: {
        adapter: string;
        phase: AuditPhase;
        resourceId?: string;
        deadlineMs?: number;
      };
    }
  | {
      type: "phase.completed";
      timestamp: string;
      data: {
        adapter: string;
        phase: AuditPhase;
        resourceId?: string;
        status: "completed" | "deadline" | "failed";
        elapsedMs: number;
        deadlineMs?: number;
      };
    }
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

class AuditPhaseDeadlineError extends Error {
  override readonly name = "AuditPhaseDeadlineError";

  constructor(
    readonly adapter: string,
    readonly phase: AuditPhase,
    readonly timeoutMs: number,
    readonly resourceId?: string,
  ) {
    super(
      `${adapter} ${phase} phase exceeded its ${timeoutMs}ms deadline${
        resourceId === undefined ? "" : ` for ${resourceId}`
      }`,
    );
  }
}

function phaseDeadlineDiagnostic(error: AuditPhaseDeadlineError): Diagnostic {
  return {
    severity: "warning",
    code: "AUDIT_PHASE_DEADLINE_EXCEEDED",
    message: error.message,
    adapter: error.adapter,
    ...(error.resourceId === undefined ? {} : { resourceId: error.resourceId }),
    remediation: "Treat this inventory as partial and rerun after resolving the slow provider.",
  };
}

async function runPhase<T>(options: {
  adapter: string;
  phase: AuditPhase;
  context: AuditContext;
  resourceId?: string;
  timeoutMs?: number;
  clock: () => Date;
  monotonicNow: () => number;
  onEvent?: (event: AuditProgressEvent) => void;
  operation: (context: AuditContext) => Promise<T>;
}): Promise<T> {
  options.context.signal?.throwIfAborted();
  const controller = new AbortController();
  const eventData = {
    adapter: options.adapter,
    phase: options.phase,
    ...(options.resourceId === undefined ? {} : { resourceId: options.resourceId }),
    ...(options.timeoutMs === undefined ? {} : { deadlineMs: options.timeoutMs }),
  };
  options.onEvent?.({
    type: "phase.started",
    timestamp: options.clock().toISOString(),
    data: eventData,
  });

  const startedAt = options.monotonicNow();
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectOnAbort = (): void => {
    rejectAbort?.(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("audit phase aborted"),
    );
  };
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  const relayAbort = (): void => {
    controller.abort(options.context.signal?.reason);
  };
  options.context.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.context.signal?.aborted === true) {
    relayAbort();
  }
  if (options.timeoutMs !== undefined) {
    const deadline = new AuditPhaseDeadlineError(
      options.adapter,
      options.phase,
      options.timeoutMs,
      options.resourceId,
    );
    timer = setTimeout(() => controller.abort(deadline), options.timeoutMs);
  }

  try {
    const phaseContext: AuditContext = {
      ...options.context,
      signal: controller.signal,
    };
    const result = await Promise.race([options.operation(phaseContext), aborted]);
    options.onEvent?.({
      type: "phase.completed",
      timestamp: options.clock().toISOString(),
      data: {
        ...eventData,
        status: "completed",
        elapsedMs: Math.max(0, options.monotonicNow() - startedAt),
      },
    });
    return result;
  } catch (error) {
    options.onEvent?.({
      type: "phase.completed",
      timestamp: options.clock().toISOString(),
      data: {
        ...eventData,
        status: error instanceof AuditPhaseDeadlineError ? "deadline" : "failed",
        elapsedMs: Math.max(0, options.monotonicNow() - startedAt),
      },
    });
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    controller.signal.removeEventListener("abort", rejectOnAbort);
    options.context.signal?.removeEventListener("abort", relayAbort);
  }
}

export async function runAudit(options: RunAuditOptions): Promise<AuditReport> {
  if (
    options.phaseTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.phaseTimeoutMs) || options.phaseTimeoutMs < 1)
  ) {
    throw new Error("runAudit phaseTimeoutMs must be a positive integer");
  }
  const clock = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
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
    let probe: Awaited<ReturnType<AuditAdapter["probe"]>>;
    try {
      probe = await runPhase({
        adapter: adapter.id,
        phase: "probe",
        context,
        clock,
        monotonicNow,
        ...(options.phaseTimeoutMs === undefined ? {} : { timeoutMs: options.phaseTimeoutMs }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        operation: (phaseContext) => adapter.probe(phaseContext),
      });
    } catch (error) {
      if (!(error instanceof AuditPhaseDeadlineError)) {
        throw error;
      }
      const diagnostic = phaseDeadlineDiagnostic(error);
      probe = {
        adapter: adapter.id,
        status: "degraded",
        detail: error.message,
        diagnostics: [diagnostic],
      };
    }
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

    if (
      probe.status === "degraded" &&
      probe.diagnostics.some((diagnostic) => diagnostic.code === "AUDIT_PHASE_DEADLINE_EXCEEDED")
    ) {
      continue;
    }

    let collection: Awaited<ReturnType<AuditAdapter["collect"]>>;
    try {
      collection = await runPhase({
        adapter: adapter.id,
        phase: "collect",
        context,
        clock,
        monotonicNow,
        ...(options.phaseTimeoutMs === undefined ? {} : { timeoutMs: options.phaseTimeoutMs }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        operation: (phaseContext) => adapter.collect(phaseContext, probe),
      });
    } catch (error) {
      if (!(error instanceof AuditPhaseDeadlineError)) {
        throw error;
      }
      const diagnostic = phaseDeadlineDiagnostic(error);
      diagnostics.push(diagnostic);
      options.onEvent?.({
        type: "diagnostic.reported",
        timestamp: clock().toISOString(),
        data: diagnostic,
      });
      continue;
    }
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
      let finding: Finding;
      try {
        finding = await runPhase({
          adapter: adapter.id,
          phase: "classify",
          context,
          resourceId: resource.resource.id,
          clock,
          monotonicNow,
          ...(options.phaseTimeoutMs === undefined ? {} : { timeoutMs: options.phaseTimeoutMs }),
          ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
          operation: (phaseContext) => adapter.classify(phaseContext, resource),
        });
      } catch (error) {
        if (!(error instanceof AuditPhaseDeadlineError)) {
          throw error;
        }
        const diagnostic = phaseDeadlineDiagnostic(error);
        diagnostics.push(diagnostic);
        options.onEvent?.({
          type: "diagnostic.reported",
          timestamp: clock().toISOString(),
          data: diagnostic,
        });
        finding = {
          schemaVersion: 1,
          findingId: randomUUID(),
          auditId: context.auditId,
          observedAt: clock().toISOString(),
          resource: resource.resource,
          state: "unknown",
          confidence: "unknown",
          roots: [
            {
              code: "audit-phase-deadline",
              source: "agentrinse",
              observedAt: clock().toISOString(),
              detail: "Classification did not complete before the phase deadline.",
            },
          ],
          facts: {
            ...resource.facts,
            partial: true,
            incompletePhase: "classify",
          },
          candidateActions: [],
          warnings: [diagnostic],
        };
      }
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
