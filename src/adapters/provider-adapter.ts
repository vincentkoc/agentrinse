import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AuditAdapter,
  AuditContext,
  CollectionResult,
} from "../contracts/adapter.js";
import type { Diagnostic } from "../contracts/diagnostic.js";
import type { Finding } from "../contracts/finding.js";
import type { AdapterProbe } from "../contracts/report.js";
import type { ResourceSnapshot } from "../contracts/resource.js";
import { sha256 } from "../core/digest.js";
import { measurePath } from "../core/measure.js";
import type { ProviderSpec } from "./provider-specs.js";

export type ProviderAdapterOptions = {
  root?: string;
  platform?: NodeJS.Platform;
  measureBytes: boolean;
  maxEntries: number;
};

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class ProviderAuditAdapter implements AuditAdapter {
  readonly id: string;

  constructor(
    private readonly spec: ProviderSpec,
    private readonly options: ProviderAdapterOptions,
  ) {
    this.id = spec.id;
  }

  private root(context: AuditContext): string {
    return resolve(
      this.options.root ??
        this.spec.defaultRoot(
          context.home,
          this.options.platform ?? process.platform,
        ),
    );
  }

  async probe(context: AuditContext): Promise<AdapterProbe> {
    const root = this.root(context);

    try {
      const stats = await lstat(root);
      if (stats.isSymbolicLink()) {
        return {
          adapter: this.id,
          status: "degraded",
          root,
          detail: `${this.spec.displayName} root is a symlink; audit is blocked`,
          diagnostics: [
            {
              severity: "warning",
              code: "PROVIDER_ROOT_SYMLINK",
              message: "Provider roots must resolve without following symlinks.",
              adapter: this.id,
            },
          ],
        };
      }

      if (!stats.isDirectory()) {
        return {
          adapter: this.id,
          status: "degraded",
          root,
          detail: `${this.spec.displayName} root is not a directory`,
          diagnostics: [
            {
              severity: "warning",
              code: "PROVIDER_ROOT_NOT_DIRECTORY",
              message: "The configured provider root is not a directory.",
              adapter: this.id,
            },
          ],
        };
      }

      return {
        adapter: this.id,
        status: "available",
        root,
        detail: `${this.spec.displayName} data root found`,
        diagnostics: [],
      };
    } catch (error) {
      if (isMissing(error)) {
        return {
          adapter: this.id,
          status: "absent",
          root,
          detail: `${this.spec.displayName} data root not found`,
          diagnostics: [],
        };
      }

      return {
        adapter: this.id,
        status: "degraded",
        root,
        detail: `${this.spec.displayName} data root could not be inspected`,
        diagnostics: [
          {
            severity: "warning",
            code: "PROVIDER_ROOT_UNREADABLE",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          },
        ],
      };
    }
  }

  async collect(
    context: AuditContext,
    probe: AdapterProbe,
  ): Promise<CollectionResult> {
    if (probe.status !== "available" || probe.root === undefined) {
      return { resources: [], diagnostics: [] };
    }

    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];

    for (const candidate of this.spec.resources) {
      context.signal?.throwIfAborted();
      const path =
        candidate.relativePath === "."
          ? probe.root
          : join(probe.root, candidate.relativePath);

      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink()) {
          diagnostics.push({
            severity: "warning",
            code: "RESOURCE_SYMLINK_SKIPPED",
            message: "A provider resource symlink was not followed.",
            adapter: this.id,
          });
          continue;
        }

        const measurement = this.options.measureBytes
          ? await measurePath(path, {
              maxEntries: this.options.maxEntries,
              ...(context.signal === undefined
                ? {}
                : { signal: context.signal }),
            })
          : undefined;
        const canonicalKey = `${this.id}:${candidate.kind}:${resolve(path)}`;
        const resourceId = `${this.id}:${candidate.kind}:${sha256(canonicalKey)}`;

        resources.push({
          resource: {
            id: resourceId,
            adapter: this.id,
            kind: candidate.kind,
            canonicalKey,
            displayName: candidate.displayName,
            path: resolve(path),
          },
          observedAt: context.now.toISOString(),
          exists: true,
          ...(measurement === undefined
            ? {}
            : { measuredBytes: measurement.bytes }),
          facts: {
            reportOnly: true,
            entries: measurement?.entries,
            symlinksSkipped: measurement?.symlinksSkipped,
            measurementTruncated: measurement?.truncated,
          },
        });
      } catch (error) {
        if (isMissing(error)) {
          continue;
        }

        diagnostics.push({
          severity: "warning",
          code: "RESOURCE_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
      }
    }

    return { resources, diagnostics };
  }

  async classify(
    context: AuditContext,
    resource: ResourceSnapshot,
  ): Promise<Finding> {
    const observedAt = context.now.toISOString();
    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state: "protected",
      confidence: "certain",
      roots: [
        {
          code: "provider-owned-report-only",
          source: this.id,
          observedAt,
          detail:
            "The pre-alpha adapter inventories this provider state but cannot clean it.",
        },
      ],
      facts: resource.facts,
      ...(resource.measuredBytes === undefined
        ? {}
        : { measuredBytes: resource.measuredBytes }),
      warnings: [],
    };
  }
}
