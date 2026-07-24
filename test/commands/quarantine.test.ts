import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executePurgeCommand } from "../../src/commands/purge.js";
import { executeUndoCommand } from "../../src/commands/undo.js";
import type { QuarantineEntry } from "../../src/contracts/quarantine.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";
import { stateLayout } from "../../src/state/layout.js";

function entry(
  entryId: string,
  runId: string,
  expiresAt: string,
  actionId = `action-${entryId}`,
): QuarantineEntry {
  return {
    schemaVersion: 1,
    entryId,
    runId,
    actionId,
    resourceId: `resource-${entryId}`,
    status: "quarantined",
    originalPath: `/tmp/${entryId}`,
    quarantinePath: `/tmp/.agentrinse-quarantine/${entryId}`,
    recoveryRef: `refs/agentrinse/quarantine/${runId}/${entryId}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt,
    target: {
      path: `/tmp/${entryId}`,
      repositoryCommonDir: "/tmp/repo/.git",
      head: "a".repeat(40),
      branch: "refs/heads/feature",
      device: 1,
      inode: 2,
      mtimeMs: 3,
      measuredBytes: 1024,
      newestMtimeMs: 4,
      fingerprint: "b".repeat(64),
    },
    quarantineIdentity: {
      path: `/tmp/.agentrinse-quarantine/${entryId}`,
      repositoryCommonDir: "/tmp/repo/.git",
      head: "a".repeat(40),
      branch: "refs/heads/feature",
      device: 1,
      inode: 2,
      mtimeMs: 5,
      measuredBytes: 1024,
      newestMtimeMs: 6,
      fingerprint: "c".repeat(64),
    },
  };
}

async function stateFixture(entries: QuarantineEntry[]): Promise<{
  home: string;
  stateRoot: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-quarantine-command-"));
  const stateRoot = join(home, "state");
  const layout = stateLayout(stateRoot);
  for (const value of entries) {
    await writeJsonAtomic(join(layout.quarantine, `${value.entryId}.json`), value, {
      privateDirectories: [layout.quarantine],
    });
  }
  return { home, stateRoot };
}

describe("undo command", () => {
  it("restores selected entries from one run under the mutation lock", async () => {
    const selected = entry("one", "run-1", "2026-08-01T00:00:00.000Z");
    const ignored = entry("two", "run-2", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([selected, ignored]);
    const undo = vi.fn(async (value: QuarantineEntry) => ({
      ...value,
      status: "restored" as const,
      restoredAt: "2026-07-24T00:00:00.000Z",
    }));

    const result = await executeUndoCommand({
      runId: "run-1",
      home: fixture.home,
      stateDir: fixture.stateRoot,
      yes: true,
      json: false,
      dependencies: { undo },
    });

    expect(undo).toHaveBeenCalledOnce();
    expect(result.entries.map((value) => value.entryId)).toEqual(["one"]);
    expect(result.output).toContain("restored 1");
  });

  it("requires --yes for machine-readable mutation", async () => {
    await expect(
      executeUndoCommand({
        runId: "run-1",
        home: "/unused",
        yes: false,
        json: true,
      }),
    ).rejects.toThrow("undo --json requires --yes");
  });
});

describe("purge command", () => {
  it("previews only expired entries without mutation", async () => {
    const expired = entry("expired", "run-1", "2026-07-10T00:00:00.000Z");
    const live = entry("live", "run-2", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([expired, live]);

    const result = await executePurgeCommand({
      home: fixture.home,
      stateDir: fixture.stateRoot,
      expired: true,
      apply: false,
      yes: false,
      json: false,
      now: new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(result.applied).toBe(false);
    expect(result.entries.map((value) => value.entryId)).toEqual(["expired"]);
    expect(result.output).toContain("Preview only");
  });

  it("allows explicit run purge before expiry", async () => {
    const live = entry("live", "run-2", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([live]);
    const purge = vi.fn(async (value: QuarantineEntry) => ({
      entry: {
        ...value,
        status: "purged" as const,
        purgedAt: "2026-07-24T00:00:00.000Z",
      },
      reclaimedBytes: value.target.measuredBytes,
    }));

    const result = await executePurgeCommand({
      home: fixture.home,
      stateDir: fixture.stateRoot,
      expired: false,
      runId: "run-2",
      apply: true,
      yes: true,
      json: true,
      dependencies: { purge },
    });

    expect(purge).toHaveBeenCalledWith(live, expect.objectContaining({ allowUnexpired: true }));
    expect(result.applied).toBe(true);
    expect(result.reclaimedBytes).toBe(1024);
  });

  it("refuses unscoped destructive purge", async () => {
    await expect(
      executePurgeCommand({
        home: "/unused",
        expired: false,
        apply: true,
        yes: true,
        json: false,
      }),
    ).rejects.toThrow("requires --expired or --run");
  });
});
