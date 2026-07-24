import { describe, expect, it } from "vitest";

import { quarantineEntrySchema } from "../../src/contracts/quarantine.js";

describe("quarantineEntrySchema", () => {
  it("accepts a recoverable worktree quarantine manifest", () => {
    const entry = quarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId: "entry-1",
      runId: "run-1",
      actionId: "action-1",
      resourceId: "git:git-worktree:fixture",
      status: "quarantined",
      originalPath: "/tmp/repo-worktree",
      quarantinePath: "/tmp/.agentrinse-quarantine/entry-1",
      recoveryRef: "refs/agentrinse/quarantine/run-1/fixture",
      createdAt: "2026-07-24T00:00:00.000Z",
      expiresAt: "2026-07-31T00:00:00.000Z",
      measurementMaxEntries: 10_000,
      target: {
        path: "/tmp/repo-worktree",
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
        path: "/tmp/.agentrinse-quarantine/entry-1",
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
    });

    expect(entry.status).toBe("quarantined");
    expect(entry.target.measuredBytes).toBe(1024);
  });

  it("rejects entry IDs that can escape the manifest directory", () => {
    expect(() =>
      quarantineEntrySchema.parse({
        schemaVersion: 1,
        entryId: "../../other-state",
        runId: "run-1",
        actionId: "action-1",
        resourceId: "resource-1",
        status: "preparing",
        originalPath: "/tmp/worktree",
        quarantinePath: "/tmp/.agentrinse-quarantine/entry-1",
        recoveryRef: "refs/agentrinse/quarantine/run-1/fixture",
        createdAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        measurementMaxEntries: 10_000,
        target: {
          path: "/tmp/worktree",
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
      }),
    ).toThrow("entry ID must be filename-safe");
  });
});
