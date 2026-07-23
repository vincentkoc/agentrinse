import { describe, expect, it } from "vitest";

import { findingSchema } from "../../src/contracts/finding.js";

describe("findingSchema", () => {
  it("accepts earlier schemaVersion 1 findings without candidate actions", () => {
    const finding = findingSchema.parse({
      schemaVersion: 1,
      findingId: "finding-1",
      auditId: "audit-1",
      observedAt: "2026-07-23T00:00:00.000Z",
      resource: {
        id: "resource-1",
        adapter: "codex",
        kind: "agent-session-store",
        canonicalKey: "codex:session:1",
        displayName: "session 1",
      },
      state: "protected",
      confidence: "certain",
      roots: [],
      facts: {},
      warnings: [],
    });

    expect(finding.candidateActions).toEqual([]);
  });
});
