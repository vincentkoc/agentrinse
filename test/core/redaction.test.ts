import { describe, expect, it } from "vitest";

import type { AuditReport } from "../../src/contracts/report.js";
import { redactAuditReport } from "../../src/core/redaction.js";

const HOME = "/tmp/private-user";

const REPORT: AuditReport = {
  schemaVersion: 1,
  auditId: "audit-private",
  startedAt: "2026-07-24T00:00:00.000Z",
  completedAt: "2026-07-24T00:00:01.000Z",
  home: HOME,
  probes: [
    {
      adapter: "artifacts",
      status: "available",
      root: `${HOME}/src/secret-client`,
      detail: `Root ${HOME}/src/secret-client is available`,
      diagnostics: [],
    },
  ],
  findings: [
    {
      schemaVersion: 1,
      findingId: "finding-private",
      auditId: "audit-private",
      observedAt: "2026-07-24T00:00:00.000Z",
      resource: {
        id: "resource-private",
        adapter: "artifacts",
        kind: "build-artifact",
        canonicalKey: `artifacts:${HOME}/src/secret-client/node_modules`,
        displayName: "node_modules",
        path: `${HOME}/src/secret-client/node_modules`,
      },
      state: "eligible",
      confidence: "certain",
      roots: [],
      facts: {
        projectRoot: `${HOME}/src/secret-client`,
        hostname: "private-host",
      },
      candidateActions: [
        {
          actionId: "action-private",
          type: "artifacts.remove",
          adapter: "artifacts",
          resourceId: "resource-private",
          risk: "safe",
          description: "remove private artifact",
          expectedReclaimBytes: 10,
          target: {
            path: `${HOME}/src/secret-client/node_modules`,
            projectRoot: `${HOME}/src/secret-client`,
            name: "node_modules",
            device: 1,
            inode: 2,
            mtimeMs: 3,
            measuredBytes: 10,
            newestMtimeMs: 4,
            fingerprint: "a".repeat(64),
          },
        },
      ],
      warnings: [],
    },
  ],
  diagnostics: [],
};

describe("audit redaction", () => {
  it("removes exact paths, hostnames, identifiers, and executable actions", () => {
    const redacted = redactAuditReport(REPORT, "fixture-salt");
    const output = JSON.stringify(redacted);

    expect(output).not.toContain(HOME);
    expect(output).not.toContain("secret-client");
    expect(output).not.toContain("private-host");
    expect(output).not.toContain("resource-private");
    expect(redacted.home).toBe("$HOME");
    expect(redacted.findings[0]?.candidateActions).toEqual([]);
    expect(redacted.findings[0]?.resource.path).toMatch(/^\$HOME\/<path:/u);
  });

  it("uses report-specific salts for unlinkable identifiers", () => {
    const first = redactAuditReport(REPORT, "salt-one");
    const second = redactAuditReport(REPORT, "salt-two");

    expect(first.findings[0]?.resource.id).not.toBe(second.findings[0]?.resource.id);
  });
});
