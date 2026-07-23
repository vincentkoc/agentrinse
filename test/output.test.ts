import { describe, expect, it } from "vitest";

import type { AuditReport } from "../src/contracts/report.js";
import { formatBytes, renderAudit } from "../src/output.js";

describe("formatBytes", () => {
  it("formats binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MiB");
  });
});

describe("renderAudit", () => {
  it("states that the current release is report-only", () => {
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

    expect(renderAudit(report)).toContain("No cleanup actions are implemented.");
  });
});
