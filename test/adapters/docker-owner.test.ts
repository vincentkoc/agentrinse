import { describe, expect, it } from "vitest";

import {
  dockerBuildCacheIsOldEnough,
  inspectDockerBuildCache,
  inspectDockerContext,
  inspectDockerScope,
  supportsDockerBuildxContract,
  type DockerRunner,
} from "../../src/adapters/docker/owner.js";

function scopeRunner(overrides: Record<string, string> = {}): DockerRunner {
  const outputs: Record<string, string> = {
    "context show": "fixture\n",
    "context inspect fixture --format {{json .Endpoints.docker.Host}}":
      '"unix:///fixture/docker.sock"\n',
    "--context fixture info --format {{json .}}": JSON.stringify({
      ID: "daemon-fixture",
      ServerVersion: "29.0.0",
    }),
    "buildx version": "github.com/docker/buildx v0.35.0 fixture\n",
    "--context fixture buildx ls --format=json": `${JSON.stringify({
      Current: true,
      Driver: "docker-container",
      Dynamic: false,
      Name: "fixture-builder",
      Nodes: [
        {
          Endpoint: "fixture",
          IDs: ["worker-b", "worker-a"],
          Name: "fixture-builder0",
          Status: "running",
          Version: "v0.24.0",
        },
      ],
    })}\n`,
    ...overrides,
  };
  return async (args) => {
    const key = args.join(" ");
    const output = outputs[key];
    if (output === undefined) {
      throw new Error(`unexpected Docker command: ${key}`);
    }
    return output;
  };
}

describe("Docker owner contract", () => {
  it("inspects the daemon without requiring Buildx", async () => {
    const context = await inspectDockerContext(scopeRunner());

    expect(context).toEqual({
      name: "fixture",
      endpoint: "unix:///fixture/docker.sock",
      daemonId: "daemon-fixture",
      serverVersion: "29.0.0",
      commandPrefix: ["--context", "fixture"],
    });
  });

  it("preserves DOCKER_HOST instead of overriding it with the default context", async () => {
    const calls: string[] = [];
    const runner: DockerRunner = async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command === "context show") {
        return "default\n";
      }
      if (command === "info --format {{json .}}") {
        return JSON.stringify({ ID: "remote-daemon", ServerVersion: "29.0.0" });
      }
      throw new Error(`unexpected Docker command: ${command}`);
    };

    const context = await inspectDockerContext(runner, {
      DOCKER_HOST: "tcp://docker.example.invalid:2376",
    });

    expect(context).toEqual({
      name: "default",
      endpoint: "tcp://docker.example.invalid:2376",
      daemonId: "remote-daemon",
      serverVersion: "29.0.0",
      commandPrefix: [],
    });
    expect(calls).not.toContain("context inspect default --format {{json .Endpoints.docker.Host}}");
  });

  it("pins the context, daemon, selected builder, and stable worker identity", async () => {
    const scope = await inspectDockerScope(scopeRunner());

    expect(scope).toMatchObject({
      buildxVersion: "0.35.0",
      context: {
        name: "fixture",
        endpoint: "unix:///fixture/docker.sock",
        daemonId: "daemon-fixture",
        serverVersion: "29.0.0",
      },
      builder: {
        name: "fixture-builder",
        driver: "docker-container",
        nodes: [
          {
            name: "fixture-builder0",
            endpoint: "fixture",
            workerIds: ["worker-a", "worker-b"],
          },
        ],
      },
    });
    expect(scope.builder.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("honors an explicit Buildx builder override instead of the stored current builder", async () => {
    const runner = scopeRunner({
      "--context fixture buildx ls --format=json": [
        JSON.stringify({
          Current: true,
          Driver: "docker",
          Dynamic: false,
          Name: "stored-current",
          Nodes: [
            {
              Endpoint: "fixture",
              IDs: ["stored-worker"],
              Name: "stored-current0",
              Status: "running",
            },
          ],
        }),
        JSON.stringify({
          Current: false,
          Driver: "remote",
          Dynamic: false,
          Name: "environment-builder",
          Nodes: [
            {
              Endpoint: "tcp://builder.example.invalid:1234",
              IDs: ["remote-worker"],
              Name: "environment-builder0",
              Status: "running",
            },
          ],
        }),
      ].join("\n"),
    });

    const scope = await inspectDockerScope(runner, "environment-builder");

    expect(scope.builder).toMatchObject({
      name: "environment-builder",
      driver: "remote",
    });
  });

  it("treats an empty Buildx builder override as unset", async () => {
    const scope = await inspectDockerScope(scopeRunner(), "");

    expect(scope.builder.name).toBe("fixture-builder");
  });

  it("fails closed for uninspected Buildx versions and unhealthy builders", async () => {
    expect(supportsDockerBuildxContract("0.32.1")).toBe(false);
    expect(supportsDockerBuildxContract("0.33.0")).toBe(true);
    expect(supportsDockerBuildxContract("0.35.0")).toBe(true);
    expect(supportsDockerBuildxContract("0.35.0+vendor.1")).toBe(true);
    expect(supportsDockerBuildxContract("0.33.0-rc1")).toBe(false);
    expect(supportsDockerBuildxContract("0.35.0-desktop.1")).toBe(false);
    expect(supportsDockerBuildxContract("0.36.0")).toBe(false);

    await expect(
      inspectDockerScope(
        scopeRunner({
          "buildx version": "github.com/docker/buildx v0.33.0-rc1 future\n",
        }),
      ),
    ).rejects.toThrow("outside the inspected");
    await expect(
      inspectDockerScope(
        scopeRunner({
          "buildx version": "github.com/docker/buildx v0.36.0 future\n",
        }),
      ),
    ).rejects.toThrow("outside the inspected");
    await expect(
      inspectDockerScope(
        scopeRunner({
          "--context fixture buildx ls --format=json": `${JSON.stringify({
            Current: true,
            Driver: "docker-container",
            Dynamic: false,
            Name: "fixture-builder",
            Nodes: [
              {
                Endpoint: "fixture",
                Err: "connection failed",
                Name: "fixture-builder0",
                Status: "error",
              },
            ],
          })}\n`,
        }),
      ),
    ).rejects.toThrow("not healthy and running");
  });

  it("parses exact cache facts from the selected builder", async () => {
    const scope = await inspectDockerScope(scopeRunner());
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
      calls.push(args);
      return `${JSON.stringify({
        CreatedAt: "2026-07-01T00:00:00Z",
        ID: "abcdefghijklmnopqrstuvwx",
        LastUsedAt: "2026-07-10T00:00:00Z",
        Mutable: false,
        Parents: ["parent-b", "parent-a"],
        Reclaimable: true,
        Shared: false,
        Size: "829889526",
        Type: "regular",
        UsageCount: 1,
      })}\n`;
    };

    const records = await inspectDockerBuildCache(scope, runner);

    expect(calls).toEqual([
      ["--context", "fixture", "buildx", "du", "--builder", "fixture-builder", "--format=json"],
    ]);
    expect(records[0]).toMatchObject({
      id: "abcdefghijklmnopqrstuvwx",
      createdAt: "2026-07-01T00:00:00.000Z",
      sizeBytes: 829_889_526,
      parents: ["parent-a", "parent-b"],
      ageEvidence: {
        kind: "timestamp",
        lastUsedAt: "2026-07-10T00:00:00.000Z",
      },
    });
  });

  it("accepts Docker's humanized JSON fields only with a conservative age bound", async () => {
    const scope = await inspectDockerScope(scopeRunner());
    const recordFor = async (lastUsedAt: string) =>
      (
        await inspectDockerBuildCache(scope, async () =>
          [
            JSON.stringify({
              CreatedAt: "2026-06-01 00:00:00 +0000 UTC",
              ID: "abcdefghijklmnopqrstuvwx",
              LastUsedAt: lastUsedAt,
              Mutable: false,
              Reclaimable: true,
              Shared: true,
              Size: "1.653GB",
              Type: "regular",
              UsageCount: 2,
            }),
          ].join("\n"),
        )
      )[0]!;

    const sevenDays = await recordFor("7 days ago");
    const eightDays = await recordFor("8 days ago");

    expect(dockerBuildCacheIsOldEnough(sevenDays, new Date("2026-07-29T00:00:00Z"))).toBe(false);
    expect(dockerBuildCacheIsOldEnough(eightDays, new Date("2026-07-29T00:00:00Z"))).toBe(true);
    expect(eightDays.sizeBytes).toBe(1_653_000_000);
  });

  it("treats approximate and unknown human ages as recent evidence", async () => {
    const scope = await inspectDockerScope(scopeRunner());
    const records = await inspectDockerBuildCache(scope, async () =>
      [
        ["abcdefghijklmnopqrstuvwx", "Less than a second ago"],
        ["bcdefghijklmnopqrstuvwxy", "About a minute ago"],
        ["cdefghijklmnopqrstuvwxyz", "About an hour ago"],
        ["defghijklmnopqrstuvwxyz0", "localized age text"],
      ]
        .map(([ID, LastUsedAt]) =>
          JSON.stringify({
            CreatedAt: "2026-06-01 00:00:00 +0000 UTC",
            ID,
            LastUsedAt,
            Mutable: false,
            Reclaimable: true,
            Shared: false,
            Size: 100,
            Type: "regular",
            UsageCount: 0,
          }),
        )
        .join("\n"),
    );

    expect(records.map((record) => record.ageEvidence)).toEqual([
      { kind: "relative", observed: "Less than a second ago", lowerBoundHours: 0 },
      { kind: "relative", observed: "About a minute ago", lowerBoundHours: 1 / 60 },
      { kind: "relative", observed: "About an hour ago", lowerBoundHours: 1 },
      { kind: "relative", observed: "localized age text", lowerBoundHours: 0 },
    ]);
    expect(
      records.every((record) => !dockerBuildCacheIsOldEnough(record, new Date("2026-07-29"))),
    ).toBe(true);
  });

  it("treats a missing last-use value as unknown instead of inferring age", async () => {
    const scope = await inspectDockerScope(scopeRunner());
    const [record] = await inspectDockerBuildCache(scope, async () =>
      JSON.stringify({
        CreatedAt: "2026-06-01T00:00:00Z",
        ID: "abcdefghijklmnopqrstuvwx",
        Mutable: false,
        Reclaimable: true,
        Shared: false,
        Size: 100,
        Type: "regular",
        UsageCount: 0,
      }),
    );

    expect(record?.ageEvidence).toEqual({ kind: "unknown" });
    expect(dockerBuildCacheIsOldEnough(record!, new Date("2026-07-29"))).toBe(false);
  });

  it("skips malformed cache records without suppressing valid records", async () => {
    const scope = await inspectDockerScope(scopeRunner());
    const problems: Array<{ index: number; message: string }> = [];
    const records = await inspectDockerBuildCache(
      scope,
      async () =>
        [
          JSON.stringify({
            CreatedAt: "2026-06-01T00:00:00Z",
            ID: "cache.*",
            LastUsedAt: "8 days ago",
            Mutable: false,
            Reclaimable: true,
            Shared: false,
            Size: 100,
            Type: "regular",
            UsageCount: 0,
          }),
          JSON.stringify({
            CreatedAt: "2026-06-01T00:00:00Z",
            ID: "abcdefghijklmnopqrstuvwx",
            LastUsedAt: "8 days ago",
            Mutable: false,
            Reclaimable: true,
            Shared: false,
            Size: 200,
            Type: "regular",
            UsageCount: 0,
          }),
        ].join("\n"),
      (index, error) => problems.push({ index, message: error.message }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("abcdefghijklmnopqrstuvwx");
    expect(problems).toEqual([{ index: 0, message: "Docker build-cache ID is unsupported" }]);
  });
});
