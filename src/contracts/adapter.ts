import type { Diagnostic } from "./diagnostic.js";
import type { Finding } from "./finding.js";
import type { AdapterProbe } from "./report.js";
import type { ResourceSnapshot } from "./resource.js";

export type AuditContext = {
  home: string;
  now: Date;
  auditId: string;
  signal?: AbortSignal;
};

export type CollectionResult = {
  resources: ResourceSnapshot[];
  diagnostics: Diagnostic[];
};

export interface AuditAdapter {
  readonly id: string;
  probe(context: AuditContext): Promise<AdapterProbe>;
  collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult>;
  classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding>;
}
