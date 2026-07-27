import { readFile } from "node:fs/promises";

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

  it("publishes candidate actions as optional input", async () => {
    const schema = JSON.parse(await readFile("schemas/audit.schema.json", "utf8")) as {
      properties: {
        findings: {
          items: {
            required: string[];
          };
        };
      };
    };

    expect(schema.properties.findings.items.required).not.toContain("candidateActions");
  });

  it("accepts provider-owned cache resources", () => {
    const finding = findingSchema.parse({
      schemaVersion: 1,
      findingId: "finding-cache-1",
      auditId: "audit-1",
      observedAt: "2026-07-27T00:00:00.000Z",
      resource: {
        id: "resource-cache-1",
        adapter: "claude",
        kind: "agent-cache",
        canonicalKey: "claude:cache:changelog",
        displayName: "Claude changelog cache",
      },
      state: "protected",
      confidence: "certain",
      roots: [],
      facts: {},
      warnings: [],
    });

    expect(finding.resource.kind).toBe("agent-cache");
  });
});
