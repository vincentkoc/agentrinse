import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeLockRecoverCommand, executeLockStatusCommand } from "../../src/commands/lock.js";
import { stateLayout } from "../../src/state/layout.js";
import type { ApplyLockOwner } from "../../src/state/lock.js";

async function fixture(): Promise<{
  home: string;
  stateRoot: string;
  path: string;
  owner: ApplyLockOwner;
}> {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-lock-command-"));
  const stateRoot = join(home, "state");
  const path = join(stateLayout(stateRoot).locks, "apply.lock");
  const owner: ApplyLockOwner = {
    token: "fixture-token",
    pid: 42,
    processStartIdentity: "fixture-start",
    hostname: hostname(),
    command: "agentrinse apply",
    planId: "plan-1",
    runId: "run-1",
    createdAt: "2026-07-23T00:00:00.000Z",
  };
  await mkdir(stateLayout(stateRoot).locks, { recursive: true });
  await writeFile(path, `${JSON.stringify(owner)}\n`);
  return { home, stateRoot, path, owner };
}

describe("lock commands", () => {
  it("renders status in human and JSON modes", async () => {
    const value = await fixture();
    const dependencies = {
      inspectProcess: async () => ({ status: "alive" as const, identity: "fixture-start" }),
    };

    const human = await executeLockStatusCommand({
      home: value.home,
      stateDir: value.stateRoot,
      json: false,
      dependencies,
    });
    expect(human.output).toContain("apply lock: active");
    expect(human.output).toContain("run: run-1");

    const json = await executeLockStatusCommand({
      home: value.home,
      stateDir: value.stateRoot,
      json: true,
      dependencies,
    });
    expect(JSON.parse(json.output)).toMatchObject({ status: "active" });
  });

  it("requires explicit authorization and a proven stale owner", async () => {
    const value = await fixture();
    const dependencies = {
      inspectProcess: async () => ({ status: "dead" as const }),
    };

    await expect(
      executeLockRecoverCommand({
        home: value.home,
        stateDir: value.stateRoot,
        json: false,
        yes: false,
        dependencies,
      }),
    ).rejects.toThrow("requires --yes");

    const result = await executeLockRecoverCommand({
      home: value.home,
      stateDir: value.stateRoot,
      json: false,
      yes: true,
      dependencies,
    });
    expect(result.output).toBe("recovered stale apply lock for run run-1\n");
    await expect(readFile(value.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
