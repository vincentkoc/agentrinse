import { describe, expect, it } from "vitest";

import type { AuditReport } from "../src/contracts/report.js";
import {
  formatBytes,
  formatReclaimBytes,
  formatRunReclaimBytes,
  renderAudit,
} from "../src/output.js";

describe("formatBytes", () => {
  it("formats binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MiB");
  });
});

describe("formatReclaimBytes", () => {
  it("qualifies artifact sizes without changing the unit for other actions", () => {
    const vacuum = { type: "database.vacuum" };
    const artifact = { type: "artifacts.remove" };
    expect(formatReclaimBytes(10, [vacuum])).toBe("10 bytes");
    expect(formatReclaimBytes(10, [artifact, vacuum])).toBe(
      "10 bytes (includes logical artifact bytes)",
    );
  });
});

describe("formatRunReclaimBytes", () => {
  it("labels only actions that contributed bytes to a mixed run", () => {
    const skipped = {
      actionId: "artifact",
      type: "artifacts.remove",
      status: "skipped-stale",
    } as const;
    const vacuum = {
      actionId: "vacuum",
      type: "database.vacuum",
      status: "applied",
      reclaimedBytes: 10,
    } as const;
    expect(formatRunReclaimBytes({ reclaimedBytes: 10, actions: [skipped, vacuum] })).toBe(
      "10 bytes",
    );
    expect(formatRunReclaimBytes({ reclaimedBytes: 0, actions: [skipped] })).toBe("0 bytes");
    expect(
      formatRunReclaimBytes({
        reclaimedBytes: 19,
        actions: [{ ...skipped, status: "applied", reclaimedBytes: 9 }, vacuum],
      }),
    ).toBe("19 bytes (includes logical artifact bytes)");
  });
});

describe("renderAudit", () => {
  it("reports when no cleanup action is eligible", () => {
    const report: AuditReport = {
      schemaVersion: 1,
      auditId: "audit-1",
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:01.000Z",
      home: "/tmp/fixture",
      probes: [],
      findings: [],
      diagnostics: [],
    };

    expect(renderAudit(report)).toContain("No cleanup actions are eligible.");
  });
});
