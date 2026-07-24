import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeHistoryCommand } from "../../src/commands/history.js";
import type { CleanupRun } from "../../src/contracts/run.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";
import { stateLayout } from "../../src/state/layout.js";

function run(runId: string, startedAt: string, status: CleanupRun["status"]): CleanupRun {
  return {
    schemaVersion: 1,
    runId,
    planId: `plan-${runId}`,
    startedAt,
    completedAt: startedAt,
    status,
    actions: [],
    reclaimedBytes: 0,
    diagnostics: [],
  };
}

describe("history command", () => {
  it("sorts runs newest first and filters by duration", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agentrinse-history-"));
    const layout = stateLayout(stateRoot);
    await writeJsonAtomic(
      join(layout.runs, "older.json"),
      run("older", "2026-06-01T00:00:00.000Z", "completed"),
    );
    await writeJsonAtomic(
      join(layout.runs, "newer.json"),
      run("newer", "2026-07-23T00:00:00.000Z", "partial"),
    );

    const result = await executeHistoryCommand({
      home: "/unused",
      stateDir: stateRoot,
      since: "30d",
      json: false,
      now: new Date("2026-07-24T00:00:00.000Z"),
    });

    expect(result.runs.map((entry) => entry.runId)).toEqual(["newer"]);
    expect(result.output).toContain("partial");
  });

  it("reports an empty state directory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agentrinse-history-"));
    const result = await executeHistoryCommand({
      home: "/unused",
      stateDir: stateRoot,
      json: false,
    });

    expect(result.runs).toEqual([]);
    expect(result.output).toBe("No AgentRinse runs found.\n");
  });
});
