import { describe, expect, it } from "vitest";

import type { AuditReport } from "../../src/contracts/report.js";
import { redactAuditReport, redactAuditValue } from "../../src/core/redaction.js";
import { jsonDocument, ndjsonRecord } from "../../src/machine-output.js";

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
      detail: `Root ${HOME}/src/secret-client is available; mirror /Volumes/Private/client`,
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
    expect(output).not.toContain("/Volumes/Private/client");
    expect(redacted.home).toBe("$HOME");
    expect(redacted.findings[0]?.candidateActions).toEqual([]);
    expect(redacted.findings[0]?.resource.path).toMatch(/^\$HOME\/<path:/u);
  });

  it("uses report-specific salts for unlinkable identifiers", () => {
    const first = redactAuditReport(REPORT, "salt-one");
    const second = redactAuditReport(REPORT, "salt-two");

    expect(first.findings[0]?.resource.id).not.toBe(second.findings[0]?.resource.id);
  });

  it("conservatively removes diagnostic-only paths containing spaces", () => {
    const redacted = redactAuditValue(
      {
        message: "could not inspect /Users/alice/Secret Project/file after permission failure",
      },
      HOME,
      "fixture-salt",
    );
    const output = JSON.stringify(redacted);

    expect(output).not.toContain("/Users/alice");
    expect(output).not.toContain("Secret Project");
    expect(output).not.toContain("file after permission failure");
    expect(output).toContain("$PATH/<path:");
  });

  it("does not leak descendants of a path that is also present structurally", () => {
    const redacted = redactAuditValue(
      {
        path: `${HOME}/project`,
        message: `could not inspect ${HOME}/project/private/file`,
      },
      HOME,
      "fixture-salt",
    );
    const output = JSON.stringify(redacted);

    expect(output).not.toContain(HOME);
    expect(output).not.toContain("private/file");
  });

  it("removes paths adjacent to diagnostic labels", () => {
    const redacted = redactAuditValue(
      {
        message: "root:/Users/alice/private-project",
      },
      HOME,
      "fixture-salt",
    );
    const output = JSON.stringify(redacted);

    expect(output).not.toContain("/Users/alice");
    expect(output).not.toContain("private-project");
    expect(output).toContain("root:$PATH/<path:");
  });

  it("removes complete paths containing quote and angle characters", () => {
    const redacted = redactAuditValue(
      {
        message: `could not inspect /Users/alice/Secret's/"client"<draft>/file`,
      },
      HOME,
      "fixture-salt",
    );
    const output = JSON.stringify(redacted);

    expect(output).not.toContain("/Users/alice");
    expect(output).not.toContain(`Secret's`);
    expect(output).not.toContain("client");
    expect(output).not.toContain("draft");
    expect(output).toContain("$PATH/<path:");
  });

  it("removes UNC paths from JSON and NDJSON output", () => {
    const redacted = redactAuditValue(
      {
        message: String.raw`could not inspect \\server\private-share\project`,
      },
      HOME,
      "fixture-salt",
    );

    for (const output of [jsonDocument(redacted), ndjsonRecord(redacted)]) {
      expect(output).not.toContain("server");
      expect(output).not.toContain("private-share");
      expect(output).not.toContain("project");
      expect(output).toContain("$PATH/<path:");
    }
  });

  it("redacts large path collections without scanning every path for every string", () => {
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      path: `${HOME}/projects/project-${index}/node_modules`,
    }));
    const redacted = redactAuditValue(
      {
        entries,
        message: `changed ${HOME}/projects/project-4999/node_modules`,
      },
      HOME,
      "fixture-salt",
    );
    const output = JSON.stringify(redacted);

    expect(output).not.toContain(HOME);
    expect(output).not.toContain("project-4999");
    expect(output).toContain("$HOME/<path:");
  });
});
