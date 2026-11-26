import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import * as registry from "../../src/adapters/registry.js";
import { executeAuditCommand } from "../../src/commands/audit.js";

it.each([
  { deadlineMs: 25, phaseTimeoutMs: 2000, adapter: "agentrinse" },
  { deadlineMs: 2000, phaseTimeoutMs: 25, adapter: "fixture" },
])(
  "degrades a full audit on the $adapter deadline",
  async ({ deadlineMs, phaseTimeoutMs, adapter }) => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-budget-"));
    const config = join(home, "config.json");
    await writeFile(
      config,
      JSON.stringify({ schemaVersion: 1, audit: { deadlineMs, phaseTimeoutMs } }),
    );
    const adapters = vi.spyOn(registry, "createAuditAdapters").mockReturnValue([
      {
        id: "fixture",
        probe: async () => new Promise(() => {}),
        collect: async () => {
          throw new Error("unexpected collection");
        },
        classify: async () => {
          throw new Error("unexpected classification");
        },
      },
    ]);
    try {
      const result = await executeAuditCommand({ home, config, json: true });
      expect(JSON.parse(result.output).status).toBe("degraded");
      expect(result.report.diagnostics).toContainEqual(
        expect.objectContaining({
          adapter,
          code: "AUDIT_PHASE_DEADLINE_EXCEEDED",
        }),
      );
    } finally {
      adapters.mockRestore();
    }
  },
);
