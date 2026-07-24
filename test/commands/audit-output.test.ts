import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeAuditCommand } from "../../src/commands/audit.js";
import { commandEnvelopeSchema, commandEventSchema } from "../../src/contracts/output.js";
import { auditReportSchema } from "../../src/contracts/report.js";

describe("audit machine output", () => {
  it("wraps JSON output while persisting the exact report", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-output-"));
    const stateDir = await mkdtemp(join(tmpdir(), "agentrinse-audit-state-"));
    const result = await executeAuditCommand({
      home,
      stateDir,
      json: true,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });
    const envelope = commandEnvelopeSchema.parse(JSON.parse(result.output));
    const stored = auditReportSchema.parse(JSON.parse(await readFile(result.statePath, "utf8")));

    expect(envelope.command).toBe("audit");
    expect(envelope.data).toEqual(result.report);
    expect(stored).toEqual(result.report);
  });

  it("emits ordered NDJSON lifecycle records", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-output-"));
    const stateDir = await mkdtemp(join(tmpdir(), "agentrinse-audit-state-"));
    const result = await executeAuditCommand({
      home,
      stateDir,
      ndjson: true,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });
    const events = result.output
      .trim()
      .split("\n")
      .map((line) => commandEventSchema.parse(JSON.parse(line)));

    expect(events[0]?.event).toBe("command.started");
    expect(events.at(-1)?.event).toBe("command.completed");
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.commandId)).size).toBe(1);
  });

  it("redacts stdout without changing persisted evidence", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-private-home-"));
    const stateDir = await mkdtemp(join(tmpdir(), "agentrinse-audit-state-"));
    const result = await executeAuditCommand({
      home,
      stateDir,
      json: true,
      redact: true,
      now: () => new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(result.output).not.toContain(home);
    expect(await readFile(result.statePath, "utf8")).toContain(home);
  });

  it("rejects ambiguous or non-machine redaction modes", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-output-"));

    await expect(executeAuditCommand({ home, json: true, ndjson: true })).rejects.toThrow(
      "only one",
    );
    await expect(executeAuditCommand({ home, redact: true })).rejects.toThrow(
      "requires --json or --ndjson",
    );
  });
});
