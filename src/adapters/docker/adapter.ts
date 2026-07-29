import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import type { Diagnostic } from "../../contracts/diagnostic.js";
import type { Finding } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceKind, ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";
import {
  createDockerRunner,
  dockerBuildCacheIsOldEnough,
  inspectDockerBuildCache,
  inspectDockerContext,
  inspectDockerScope,
  type DockerBuildCacheRecord,
  type DockerContextIdentity,
  type DockerRunner,
  type DockerScopeIdentity,
} from "./owner.js";

export type DockerAuditAdapterOptions = {
  builderOverride?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
};

function parseJsonLines(input: string): Record<string, unknown>[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function dockerContextMatches(left: DockerContextIdentity, right: DockerContextIdentity): boolean {
  return (
    left.name === right.name &&
    left.endpoint === right.endpoint &&
    left.daemonId === right.daemonId &&
    left.serverVersion === right.serverVersion &&
    left.commandPrefix.join("\0") === right.commandPrefix.join("\0")
  );
}

function dockerScopeMatches(left: DockerScopeIdentity, right: DockerScopeIdentity): boolean {
  return (
    left.buildxVersion === right.buildxVersion &&
    dockerContextMatches(left.context, right.context) &&
    left.builder.fingerprint === right.builder.fingerprint
  );
}

function buildCacheRecord(resource: ResourceSnapshot): DockerBuildCacheRecord | undefined {
  const value = resource.facts["cache"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as DockerBuildCacheRecord;
}

export class DockerAuditAdapter implements AuditAdapter {
  readonly id = "docker";
  private dockerContext: DockerContextIdentity | undefined;
  private buildxScope: DockerScopeIdentity | undefined;

  private readonly runDocker: DockerRunner;
  private readonly options: DockerAuditAdapterOptions;

  constructor(runDocker?: DockerRunner, options: DockerAuditAdapterOptions = {}) {
    this.options = options;
    this.runDocker = runDocker ?? createDockerRunner(this.options.environment ?? process.env);
  }

  async probe(_context: AuditContext): Promise<AdapterProbe> {
    this.dockerContext = undefined;
    this.buildxScope = undefined;

    try {
      this.dockerContext = await inspectDockerContext(
        this.runDocker,
        this.options.environment ?? process.env,
      );
    } catch (error) {
      return {
        adapter: this.id,
        status: "degraded",
        detail: "Docker daemon is unavailable",
        diagnostics: [
          {
            severity: "warning",
            code: "DOCKER_DAEMON_UNAVAILABLE",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          },
        ],
      };
    }

    const diagnostics: Diagnostic[] = [];
    try {
      const scope = await inspectDockerScope(
        this.runDocker,
        this.options.builderOverride,
        this.options.environment ?? process.env,
      );
      if (!dockerContextMatches(this.dockerContext, scope.context)) {
        throw new Error("Docker context or daemon changed during Buildx inspection");
      }
      this.buildxScope = scope;
    } catch (error) {
      diagnostics.push({
        severity: "warning",
        code: "DOCKER_BUILD_CACHE_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        adapter: this.id,
        remediation:
          "Install a supported Docker Buildx release and select one healthy builder to inventory build cache.",
      });
    }

    return {
      adapter: this.id,
      status: "available",
      version: this.dockerContext.serverVersion,
      detail:
        this.buildxScope === undefined
          ? `Docker daemon available through context ${this.dockerContext.name}; Buildx cache inventory unavailable`
          : `Docker daemon and Buildx ${this.buildxScope.buildxVersion} available through context ${this.dockerContext.name}`,
      diagnostics,
    };
  }

  async collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult> {
    if (probe.status !== "available" || this.dockerContext === undefined) {
      return { resources: [], diagnostics: [] };
    }

    const collectedContext = await inspectDockerContext(
      this.runDocker,
      this.options.environment ?? process.env,
    );
    if (!dockerContextMatches(this.dockerContext, collectedContext)) {
      return {
        resources: [],
        diagnostics: [
          {
            severity: "warning",
            code: "DOCKER_OWNER_CHANGED",
            message: "Docker context or daemon changed after probing; inventory was discarded.",
            adapter: this.id,
          },
        ],
      };
    }
    this.dockerContext = collectedContext;
    const images = parseJsonLines(
      await this.runDocker([
        ...this.dockerContext.commandPrefix,
        "image",
        "ls",
        "--no-trunc",
        "--format",
        "{{json .}}",
      ]),
    );
    const containers = parseJsonLines(
      await this.runDocker([
        ...this.dockerContext.commandPrefix,
        "container",
        "ls",
        "-a",
        "--no-trunc",
        "--format",
        "{{json .}}",
      ]),
    );
    const verifiedContext = await inspectDockerContext(
      this.runDocker,
      this.options.environment ?? process.env,
    );
    if (!dockerContextMatches(this.dockerContext, verifiedContext)) {
      return {
        resources: [],
        diagnostics: [
          {
            severity: "warning",
            code: "DOCKER_OWNER_CHANGED",
            message: "Docker context or daemon changed during collection; inventory was discarded.",
            adapter: this.id,
          },
        ],
      };
    }
    const resources = [
      ...images.flatMap((image) =>
        this.toDockerResource(context, "docker-image", image, "ID", "Repository"),
      ),
      ...containers.flatMap((container) =>
        this.toDockerResource(context, "docker-container", container, "ID", "Names"),
      ),
    ];
    const diagnostics: Diagnostic[] = [];

    if (this.buildxScope !== undefined) {
      try {
        const collectedScope = await inspectDockerScope(
          this.runDocker,
          this.options.builderOverride,
          this.options.environment ?? process.env,
        );
        if (
          !dockerContextMatches(verifiedContext, collectedScope.context) ||
          !dockerScopeMatches(this.buildxScope, collectedScope)
        ) {
          throw new Error("Docker context, daemon, or builder changed before cache collection");
        }
        const unsupportedRecords: Array<{ index: number; message: string }> = [];
        const cache = await inspectDockerBuildCache(
          collectedScope,
          this.runDocker,
          (index, error) => {
            unsupportedRecords.push({ index, message: error.message });
          },
        );
        const verifiedScope = await inspectDockerScope(
          this.runDocker,
          this.options.builderOverride,
          this.options.environment ?? process.env,
        );
        if (!dockerScopeMatches(collectedScope, verifiedScope)) {
          throw new Error("Docker context, daemon, or builder changed during cache collection");
        }
        this.buildxScope = verifiedScope;
        resources.push(...cache.map((record) => this.toBuildCacheResource(context, record)));
        diagnostics.push(
          ...unsupportedRecords.map(({ index, message }) => ({
            severity: "warning" as const,
            code: "DOCKER_BUILD_CACHE_RECORD_UNSUPPORTED",
            message: `Buildx cache record ${index + 1} was skipped: ${message}`,
            adapter: this.id,
          })),
        );
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "DOCKER_BUILD_CACHE_COLLECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
          remediation: "Run docker buildx du for the selected builder and resolve its error.",
        });
      }
    }

    return { resources, diagnostics };
  }

  private toDockerResource(
    context: AuditContext,
    kind: ResourceKind,
    facts: Record<string, unknown>,
    idField: string,
    nameField: string,
  ): ResourceSnapshot[] {
    const externalId = stringField(facts, idField);
    if (externalId === undefined || this.dockerContext === undefined) {
      return [];
    }

    const canonicalKey = `docker:${this.dockerContext.daemonId}:${kind}:${externalId}`;
    return [
      {
        resource: {
          id: `docker:${kind}:${sha256(canonicalKey)}`,
          adapter: this.id,
          kind,
          canonicalKey,
          displayName: stringField(facts, nameField) ?? externalId,
          externalId,
        },
        observedAt: context.now.toISOString(),
        exists: true,
        facts: {
          ...facts,
          dockerContext: this.dockerContext,
          reportOnly: true,
        },
      },
    ];
  }

  private toBuildCacheResource(
    context: AuditContext,
    cache: DockerBuildCacheRecord,
  ): ResourceSnapshot {
    const scope = this.buildxScope!;
    const canonicalKey = [
      "docker",
      scope.context.daemonId,
      "docker-build-cache",
      scope.builder.fingerprint,
      cache.id,
    ].join(":");
    return {
      resource: {
        id: `docker:docker-build-cache:${sha256(canonicalKey)}`,
        adapter: this.id,
        kind: "docker-build-cache",
        canonicalKey,
        displayName: cache.id,
        externalId: cache.id,
      },
      observedAt: context.now.toISOString(),
      exists: true,
      ...(cache.sizeEvidence.kind === "exact" ? { measuredBytes: cache.sizeEvidence.bytes } : {}),
      facts: {
        dockerScope: scope,
        cache,
        reportOnly: true,
        mutationStatus: "unbound-owner-identity",
      },
    };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const observedAt = context.now.toISOString();
    const cache =
      resource.resource.kind === "docker-build-cache" ? buildCacheRecord(resource) : undefined;
    const root =
      cache === undefined
        ? {
            code: "docker-resource-report-only",
            source: "docker",
            observedAt,
            detail: "Docker resources are inventoried without mutation.",
          }
        : this.buildCacheRoot(cache, context.now, observedAt);
    const warnings: Diagnostic[] =
      cache?.shared === true
        ? [
            {
              severity: "info",
              code: "DOCKER_BUILD_CACHE_SHARED",
              message:
                "Docker reports this cache record as shared, so its size is not reclaimable.",
              adapter: this.id,
              resourceId: resource.resource.id,
            },
          ]
        : [];

    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state: "protected",
      confidence: "certain",
      roots: [root],
      facts: resource.facts,
      candidateActions: [],
      ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
      ...(cache === undefined
        ? {}
        : cache.sizeEvidence.kind === "exact"
          ? {
              estimatedReclaimBytes:
                cache.reclaimable && !cache.shared ? cache.sizeEvidence.bytes : 0,
            }
          : {}),
      warnings,
    };
  }

  private buildCacheRoot(cache: DockerBuildCacheRecord, now: Date, observedAt: string) {
    if (cache.mutable) {
      return {
        code: "docker-build-cache-mutable",
        source: "docker",
        observedAt,
        detail: "Docker reports this build-cache record as mutable.",
      };
    }
    if (!cache.reclaimable) {
      return {
        code: "docker-build-cache-in-use",
        source: "docker",
        observedAt,
        detail: "Docker reports this build-cache record as not reclaimable.",
      };
    }
    if (cache.recordType === "internal" || cache.recordType === "frontend") {
      return {
        code: "docker-build-cache-internal",
        source: "docker",
        observedAt,
        detail: `Docker classifies this as ${cache.recordType} build cache.`,
      };
    }
    if (!dockerBuildCacheIsOldEnough(cache, now)) {
      return {
        code: "docker-build-cache-recent",
        source: "docker",
        observedAt,
        detail: "The cache record lacks conservative proof that it is at least seven days old.",
      };
    }
    return {
      code: "docker-build-cache-mutation-unbound",
      source: "docker",
      observedAt,
      detail:
        "Buildx prune re-resolves context and builder names and cannot condition deletion on the revalidated daemon and worker identity.",
    };
  }
}
