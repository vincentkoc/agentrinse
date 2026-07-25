import { describe, expect, it } from "vitest";

import { providerFileQuarantineActionSchema } from "../../src/contracts/action.js";
import { providerFileQuarantineEntrySchema } from "../../src/contracts/provider-file-quarantine.js";

const target = {
  path: "/tmp/home/.claude/debug/session.txt",
  ownerRoot: "/tmp/home/.claude",
  relativePath: "debug/session.txt",
  provider: "claude" as const,
  device: 1,
  inode: 2,
  linkCount: 1 as const,
  mode: 0o100600,
  mtimeMs: 3,
  measuredBytes: 64,
  contentSha256: "a".repeat(64),
  fingerprint: "b".repeat(64),
};

describe("provider-file quarantine contracts", () => {
  it("accepts a complete recoverable manifest", () => {
    const entry = providerFileQuarantineEntrySchema.parse({
      schemaVersion: 1,
      entryId: "entry-1",
      runId: "run-1",
      actionId: "provider.file-quarantine:fixture",
      resourceId: "claude:agent-log:fixture",
      policyId: "claude.debug-log",
      status: "quarantined",
      originalPath: target.path,
      quarantinePath: "/tmp/state/provider-quarantine/entry-1.payload",
      createdAt: "2026-07-25T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      target,
      quarantineIdentity: {
        ...target,
        path: "/tmp/state/provider-quarantine/entry-1.payload",
        ownerRoot: "/tmp/state/provider-quarantine",
        relativePath: "entry-1.payload",
        fingerprint: "c".repeat(64),
      },
    });

    expect(entry.status).toBe("quarantined");
    expect(entry.target.contentSha256).toHaveLength(64);
  });

  it("requires the action adapter to own the target", () => {
    expect(() =>
      providerFileQuarantineActionSchema.parse({
        actionId: "provider.file-quarantine:fixture",
        type: "provider.file-quarantine",
        adapter: "cursor",
        resourceId: "claude:agent-log:fixture",
        policyId: "claude.debug-log",
        risk: "recoverable",
        description: "archive fixture",
        expectedReclaimBytes: 0,
        pendingQuarantineBytes: 64,
        quarantineTtlMinutes: 60,
        target,
      }),
    ).toThrow("must own the target");
  });

  it("requires moved identity for a live payload", () => {
    expect(() =>
      providerFileQuarantineEntrySchema.parse({
        schemaVersion: 1,
        entryId: "entry-1",
        runId: "run-1",
        actionId: "provider.file-quarantine:fixture",
        resourceId: "claude:agent-log:fixture",
        policyId: "claude.debug-log",
        status: "quarantined",
        originalPath: target.path,
        quarantinePath: "/tmp/state/provider-quarantine/entry-1.payload",
        createdAt: "2026-07-25T00:00:00.000Z",
        expiresAt: "2026-08-01T00:00:00.000Z",
        target,
      }),
    ).toThrow("expected object");
  });
});
