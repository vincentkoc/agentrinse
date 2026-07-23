import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import type { Finding } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceKind, ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";

const execFileAsync = promisify(execFile);

export type DockerRunner = (args: string[]) => Promise<string>;

async function defaultDockerRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
  });
  return result.stdout;
}

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

export class DockerAuditAdapter implements AuditAdapter {
  readonly id = "docker";

  constructor(private readonly runDocker: DockerRunner = defaultDockerRunner) {}

  async probe(_context: AuditContext): Promise<AdapterProbe> {
    try {
      const dockerContext = (await this.runDocker(["context", "show"])).trim();
      const version = (await this.runDocker(["version", "--format", "{{.Server.Version}}"])).trim();

      return {
        adapter: this.id,
        status: "available",
        version,
        detail: `Docker daemon available through context ${dockerContext}`,
        diagnostics: [],
      };
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
  }

  async collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult> {
    if (probe.status !== "available") {
      return { resources: [], diagnostics: [] };
    }

    const images = parseJsonLines(
      await this.runDocker(["image", "ls", "--no-trunc", "--format", "{{json .}}"]),
    );
    const containers = parseJsonLines(
      await this.runDocker(["container", "ls", "-a", "--no-trunc", "--format", "{{json .}}"]),
    );

    return {
      resources: [
        ...images.flatMap((image) =>
          this.toResource(context, "docker-image", image, "ID", "Repository"),
        ),
        ...containers.flatMap((container) =>
          this.toResource(context, "docker-container", container, "ID", "Names"),
        ),
      ],
      diagnostics: [],
    };
  }

  private toResource(
    context: AuditContext,
    kind: ResourceKind,
    facts: Record<string, unknown>,
    idField: string,
    nameField: string,
  ): ResourceSnapshot[] {
    const externalId = stringField(facts, idField);
    if (externalId === undefined) {
      return [];
    }

    const canonicalKey = `docker:${kind}:${externalId}`;
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
          reportOnly: true,
        },
      },
    ];
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
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
          code: "docker-audit-only",
          source: "docker",
          observedAt,
          detail: "The pre-alpha Docker adapter inventories resources but cannot prune them.",
        },
      ],
      facts: resource.facts,
      warnings: [],
    };
  }
}
