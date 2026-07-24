import { describe, expect, it } from "vitest";

import { parseDurationMs } from "../../src/core/duration.js";

describe("parseDurationMs", () => {
  it("parses supported units", () => {
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("15m")).toBe(15 * 60_000);
    expect(parseDurationMs("12h")).toBe(12 * 60 * 60_000);
    expect(parseDurationMs("30d")).toBe(30 * 24 * 60 * 60_000);
  });

  it("rejects zero, negative, fractional, and unknown units", () => {
    for (const value of ["0s", "-1h", "1.5h", "3w", "soon"]) {
      expect(() => parseDurationMs(value)).toThrow("invalid duration");
    }
  });
});
