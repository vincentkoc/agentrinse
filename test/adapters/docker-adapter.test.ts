import { describe, expect, it } from "vitest";

import { DockerAuditAdapter } from "../../src/adapters/docker/adapter.js";
import type { DockerRunner } from "../../src/adapters/docker/owner.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

const CONTEXT: AuditContext = {
  home: "/tmp/agentrinse-docker-fixture",
  now: new Date("2026-07-29T00:00:00.000Z"),
  auditId: "audit-docker",
};

const BASE_CACHE = {
  CreatedAt: "2026-06-01T00:00:00Z",
  ID: "abcdefghijklmnopqrstuvwx",
  LastUsedAt: "2026-07-01T00:00:00Z",
  Mutable: false,
  Parents: [],
  Reclaimable: true,
  Shared: false,
  Size: 4096,
  Type: "regular",
  UsageCount: 1,
};

function dockerRunner(
  options: {
    buildxError?: Error;
    cache?: Record<string, unknown>;
  } = {},
): DockerRunner {
  return async (args) => {
    const command = args.join(" ");
    if (command === "context show") {
      return "fixture\n";
    }
    if (command === "context inspect fixture --format {{json .Endpoints.docker.Host}}") {
      return '"unix:///fixture/docker.sock"\n';
    }
    if (command === "--context fixture info --format {{json .}}") {
      return JSON.stringify({ ID: "daemon-fixture", ServerVersion: "29.0.0" });
    }
    if (command === "buildx version") {
      if (options.buildxError !== undefined) {
        throw options.buildxError;
      }
      return "github.com/docker/buildx v0.35.0 fixture\n";
    }
    if (command === "--context fixture buildx ls --format=json") {
      return `${JSON.stringify({
        Current: true,
        Driver: "docker-container",
        Dynamic: false,
        Name: "fixture-builder",
        Nodes: [
          {
            Endpoint: "fixture",
            IDs: ["worker-fixture"],
            Name: "fixture-builder0",
            Status: "running",
          },
        ],
      })}\n`;
    }
    if (command === "--context fixture image ls --no-trunc --format {{json .}}") {
      return `${JSON.stringify({
        ID: "sha256:image",
        Repository: "fixture/image",
        Tag: "latest",
      })}\n`;
    }
    if (command === "--context fixture container ls -a --no-trunc --format {{json .}}") {
      return `${JSON.stringify({
        ID: "container-id",
        Names: "fixture-container",
        State: "exited",
      })}\n`;
    }
    if (command === "--context fixture buildx du --builder fixture-builder --format=json") {
      return `${JSON.stringify(options.cache ?? BASE_CACHE)}\n`;
    }
    throw new Error(`unexpected Docker command: ${command}`);
  };
}

describe("DockerAuditAdapter", () => {
  it("degrades cleanly when the daemon is unavailable", async () => {
    const adapter = new DockerAuditAdapter(async () => {
      throw new Error("socket missing");
    });

    const probe = await adapter.probe(CONTEXT);

    expect(probe.status).toBe("degraded");
    expect(probe.diagnostics[0]?.code).toBe("DOCKER_DAEMON_UNAVAILABLE");
    expect(await adapter.collect(CONTEXT, probe)).toEqual({
      resources: [],
      diagnostics: [],
    });
  });

  it("preserves image and container inventory when Buildx is unavailable", async () => {
    const adapter = new DockerAuditAdapter(
      dockerRunner({ buildxError: new Error("buildx missing") }),
    );

    const probe = await adapter.probe(CONTEXT);
    const collection = await adapter.collect(CONTEXT, probe);

    expect(probe.status).toBe("available");
    expect(probe.diagnostics[0]?.code).toBe("DOCKER_BUILD_CACHE_UNAVAILABLE");
    expect(collection.resources.map((resource) => resource.resource.kind)).toEqual([
      "docker-image",
      "docker-container",
    ]);
  });

  it("inventories Buildx cache with pinned owner facts but emits no action", async () => {
    const adapter = new DockerAuditAdapter(dockerRunner());

    const probe = await adapter.probe(CONTEXT);
    const collection = await adapter.collect(CONTEXT, probe);
    const cache = collection.resources.find(
      (resource) => resource.resource.kind === "docker-build-cache",
    )!;
    const finding = await adapter.classify(CONTEXT, cache);

    expect(collection.resources.map((resource) => resource.resource.kind)).toEqual([
      "docker-image",
      "docker-container",
      "docker-build-cache",
    ]);
    expect(cache).toMatchObject({
      measuredBytes: 4096,
      facts: {
        mutationStatus: "unbound-owner-identity",
        reportOnly: true,
        dockerScope: {
          buildxVersion: "0.35.0",
          context: { daemonId: "daemon-fixture", name: "fixture" },
          builder: { name: "fixture-builder" },
        },
      },
    });
    expect(finding).toMatchObject({
      state: "protected",
      confidence: "certain",
      measuredBytes: 4096,
      estimatedReclaimBytes: 4096,
      roots: [{ code: "docker-build-cache-mutation-unbound" }],
      candidateActions: [],
    });
  });

  it.each([
    [{ Mutable: true }, "docker-build-cache-mutable"],
    [{ Reclaimable: false }, "docker-build-cache-in-use"],
    [{ Type: "internal" }, "docker-build-cache-internal"],
    [{ LastUsedAt: "About an hour ago" }, "docker-build-cache-recent"],
  ])("protects cache evidence %# with its specific root", async (override, expectedCode) => {
    const adapter = new DockerAuditAdapter(dockerRunner({ cache: { ...BASE_CACHE, ...override } }));
    const probe = await adapter.probe(CONTEXT);
    const collection = await adapter.collect(CONTEXT, probe);
    const cache = collection.resources.find(
      (resource) => resource.resource.kind === "docker-build-cache",
    )!;

    const finding = await adapter.classify(CONTEXT, cache);

    expect(finding.state).toBe("protected");
    expect(finding.roots[0]?.code).toBe(expectedCode);
    expect(finding.candidateActions).toEqual([]);
  });

  it("reports shared cache bytes without claiming they are reclaimable", async () => {
    const adapter = new DockerAuditAdapter(
      dockerRunner({ cache: { ...BASE_CACHE, Shared: true } }),
    );
    const probe = await adapter.probe(CONTEXT);
    const collection = await adapter.collect(CONTEXT, probe);
    const cache = collection.resources.find(
      (resource) => resource.resource.kind === "docker-build-cache",
    )!;

    const finding = await adapter.classify(CONTEXT, cache);

    expect(finding.estimatedReclaimBytes).toBe(0);
    expect(finding.warnings[0]?.code).toBe("DOCKER_BUILD_CACHE_SHARED");
  });
});
