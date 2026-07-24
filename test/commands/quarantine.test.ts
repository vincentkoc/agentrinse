import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executePurgeCommand } from "../../src/commands/purge.js";
import { executeUndoCommand } from "../../src/commands/undo.js";
import { quarantineRecoveryRef, type QuarantineEntry } from "../../src/contracts/quarantine.js";
import {
  worktreePurgeIsolationPath,
  type PurgeWorktreeOptions,
} from "../../src/core/worktree-recovery.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";
import { stateLayout } from "../../src/state/layout.js";

function entry(
  entryId: string,
  runId: string,
  expiresAt: string,
  actionId = `action-${entryId}`,
): QuarantineEntry {
  const resourceId = `resource-${entryId}`;
  return {
    schemaVersion: 1,
    entryId,
    runId,
    actionId,
    resourceId,
    status: "quarantined",
    originalPath: `/tmp/${entryId}`,
    quarantinePath: `/tmp/.agentrinse-quarantine/${entryId}`,
    recoveryRef: quarantineRecoveryRef(runId, resourceId),
    createdAt: "2026-07-01T00:00:00.000Z",
    expiresAt,
    measurementMaxEntries: 10_000,
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

  it("resumes a persisted restoring entry", async () => {
    const restoring = {
      ...entry("restoring", "run-1", "2026-08-01T00:00:00.000Z"),
      status: "restoring" as const,
    };
    const fixture = await stateFixture([restoring]);
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

    expect(undo).toHaveBeenCalledWith(restoring, expect.any(Object));
    expect(result.entries[0]?.status).toBe("restored");
  });

  it("selects an interrupted initial quarantine entry for recovery", async () => {
    const interrupted = {
      ...entry("initial", "run-1", "2026-08-01T00:00:00.000Z"),
      status: "recovery-ref-created" as const,
      quarantineIdentity: undefined,
    };
    const fixture = await stateFixture([interrupted]);
    const undo = vi.fn(async (value: QuarantineEntry) => ({
      ...value,
      status: "restored" as const,
      restoredAt: "2026-07-24T00:00:00.000Z",
    }));

    await executeUndoCommand({
      runId: "run-1",
      home: fixture.home,
      stateDir: fixture.stateRoot,
      yes: true,
      json: false,
      dependencies: { undo },
    });

    expect(undo).toHaveBeenCalledWith(interrupted, expect.any(Object));
  });

  it("rejects a manifest whose entry ID does not match its filename", async () => {
    const value = entry("actual", "run-1", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([]);
    const layout = stateLayout(fixture.stateRoot);
    await writeJsonAtomic(join(layout.quarantine, "different.json"), value, {
      privateDirectories: [layout.quarantine],
    });

    await expect(
      executeUndoCommand({
        runId: "run-1",
        home: fixture.home,
        stateDir: fixture.stateRoot,
        yes: true,
        json: false,
      }),
    ).rejects.toThrow("entry ID does not match filename");
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

  it("resumes a persisted purging entry", async () => {
    const purging = {
      ...entry("purging", "run-2", "2026-08-01T00:00:00.000Z"),
      status: "purging" as const,
    };
    const fixture = await stateFixture([purging]);
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
      json: false,
      dependencies: { purge },
    });

    expect(purge).toHaveBeenCalledWith(purging, expect.any(Object));
    expect(result.entries[0]?.status).toBe("purged");
  });

  it.each([
    ["original path", (value: QuarantineEntry) => ({ path: value.originalPath })],
    ["quarantine path", (value: QuarantineEntry) => ({ path: value.quarantinePath })],
    [
      "purge isolation path",
      (value: QuarantineEntry) => ({ path: worktreePurgeIsolationPath(value) }),
    ],
    ["resource ID", (value: QuarantineEntry) => ({ resourceId: value.resourceId })],
    ["Git ref", (value: QuarantineEntry) => ({ gitRef: value.target.branch! })],
  ])("revalidates a current %s pin before destructive purge", async (_label, pinFor) => {
    const value = entry("protected", "run-2", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([value]);
    const configPath = join(fixture.home, "agentrinse.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        adapters: {
          codex: { enabled: false },
          claude: { enabled: false },
          cursor: { enabled: false },
          copilot: { enabled: false },
          zed: { enabled: false },
          opencode: { enabled: false },
          grok: { enabled: false },
          git: { enabled: true },
        },
        pins: [pinFor(value)],
      })}\n`,
    );
    const purge = vi.fn();

    await expect(
      executePurgeCommand({
        home: fixture.home,
        config: configPath,
        stateDir: fixture.stateRoot,
        expired: false,
        runId: "run-2",
        apply: true,
        yes: true,
        json: false,
        now: new Date("2026-07-24T00:00:00.000Z"),
        dependencies: { purge },
      }),
    ).rejects.toThrow("purge refused protected quarantine entry protected");

    expect(purge).not.toHaveBeenCalled();
  });

  it("revalidates current provider workspace metadata before destructive purge", async () => {
    const value = entry("provider-protected", "run-2", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([value]);
    const codexRoot = join(fixture.home, ".codex");
    await mkdir(codexRoot);
    await writeFile(
      join(codexRoot, ".codex-global-state.json"),
      `${JSON.stringify({ "active-workspace-roots": [value.originalPath] })}\n`,
    );
    const purge = vi.fn();

    await expect(
      executePurgeCommand({
        home: fixture.home,
        stateDir: fixture.stateRoot,
        expired: false,
        runId: "run-2",
        apply: true,
        yes: true,
        json: false,
        now: new Date("2026-07-24T00:00:00.000Z"),
        dependencies: { purge },
      }),
    ).rejects.toThrow("active-session");

    expect(purge).not.toHaveBeenCalled();
  });

  it("reloads protections at the permanent-removal callback", async () => {
    const value = entry("late-protected", "run-2", "2026-08-01T00:00:00.000Z");
    const fixture = await stateFixture([value]);
    const configPath = join(fixture.home, "agentrinse.json");
    const config = {
      schemaVersion: 1,
      adapters: {
        codex: { enabled: false },
        claude: { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: false },
        zed: { enabled: false },
        opencode: { enabled: false },
        grok: { enabled: false },
        git: { enabled: true },
      },
      pins: [] as { path: string }[],
    };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    const purge = vi.fn(async (candidate: QuarantineEntry, purgeOptions: PurgeWorktreeOptions) => {
      await writeFile(
        configPath,
        `${JSON.stringify({ ...config, pins: [{ path: candidate.quarantinePath }] })}\n`,
      );
      await purgeOptions.revalidateProtection?.(candidate);
      throw new Error("expected boundary protection refusal");
    });

    await expect(
      executePurgeCommand({
        home: fixture.home,
        config: configPath,
        stateDir: fixture.stateRoot,
        expired: false,
        runId: "run-2",
        apply: true,
        yes: true,
        json: false,
        now: new Date("2026-07-24T00:00:00.000Z"),
        dependencies: { purge },
      }),
    ).rejects.toThrow("purge refused protected quarantine entry late-protected");

    expect(purge).toHaveBeenCalledOnce();
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
