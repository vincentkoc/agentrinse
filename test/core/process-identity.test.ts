import { describe, expect, it, vi } from "vitest";

import { inspectProcessIdentity } from "../../src/core/process-identity.js";

describe("inspectProcessIdentity", () => {
  it("uses a fixed locale and timezone for the macOS start identity", async () => {
    const runProcessCommand = vi.fn(async () => ({
      stdout: "Fri Jul 24 00:00:00 2026\n",
      stderr: "",
    }));

    await expect(inspectProcessIdentity(42, "darwin", { runProcessCommand })).resolves.toEqual({
      status: "alive",
      identity: "darwin-ps-start:Fri Jul 24 00:00:00 2026",
    });
    expect(runProcessCommand).toHaveBeenCalledWith(
      "ps",
      ["-p", "42", "-o", "lstart="],
      expect.objectContaining({
        env: expect.objectContaining({
          LANG: "C",
          LC_ALL: "C",
          TZ: "UTC",
        }),
      }),
    );
  });
});
