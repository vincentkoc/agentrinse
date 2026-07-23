import { describe, expect, it } from "vitest";

import { DockerAuditAdapter } from "../../src/adapters/docker/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

const CONTEXT: AuditContext = {
  home: "/tmp/agentrinse-docker-fixture",
  now: new Date("2026-07-23T00:00:00.000Z"),
  auditId: "audit-docker",
};

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

  it("inventories images and containers through structured output", async () => {
    const runner = async (args: string[]) => {
      if (args[0] === "context") {
        return "fixture\n";
      }
      if (args[0] === "version") {
        return "29.0.0\n";
      }
      if (args[0] === "image") {
        return `${JSON.stringify({
          ID: "sha256:image",
          Repository: "fixture/image",
          Tag: "latest",
        })}\n`;
      }
      return `${JSON.stringify({
        ID: "container-id",
        Names: "fixture-container",
        State: "exited",
      })}\n`;
    };
    const adapter = new DockerAuditAdapter(runner);

    const probe = await adapter.probe(CONTEXT);
    const collection = await adapter.collect(CONTEXT, probe);
    const findings = await Promise.all(
      collection.resources.map((resource) =>
        adapter.classify(CONTEXT, resource),
      ),
    );

    expect(probe.status).toBe("available");
    expect(collection.resources.map((resource) => resource.resource.kind)).toEqual(
      ["docker-image", "docker-container"],
    );
    expect(findings.every((finding) => finding.state === "protected")).toBe(
      true,
    );
  });
});
