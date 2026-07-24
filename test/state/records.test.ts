import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveJsonRecordPath } from "../../src/state/records.js";

describe("resolveJsonRecordPath", () => {
  it("treats JSON basenames and either separator as explicit paths", () => {
    expect(resolveJsonRecordPath("/state/runs", "run.json")).toBe(resolve("run.json"));
    expect(resolveJsonRecordPath("/state/runs", "records/run.json")).toBe(
      resolve("records/run.json"),
    );
    expect(resolveJsonRecordPath("/state/runs", String.raw`records\run.json`)).toBe(
      resolve(String.raw`records\run.json`),
    );
  });

  it("resolves bare record IDs inside the selected state directory", () => {
    expect(resolveJsonRecordPath("/state/runs", "run-1")).toBe("/state/runs/run-1.json");
  });
});
