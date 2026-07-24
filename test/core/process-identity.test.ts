import { describe, expect, it, vi } from "vitest";

import { inspectProcessIdentity } from "../../src/core/process-identity.js";

describe("inspectProcessIdentity", () => {
  it("does not treat a missing procfs entry as proof that a live process is dead", async () => {
    const missing = Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });

    await expect(
      inspectProcessIdentity(42, "linux", {
        readProcessStat: async () => {
          throw missing;
        },
        probeProcess: () => "alive",
      }),
    ).resolves.toEqual({
      status: "unknown",
      reason: "could not inspect /proc/42/stat (ENOENT)",
    });
  });

  it("accepts an independent PID probe as proof that a process is dead", async () => {
    const missing = Object.assign(new Error("process missing"), { code: "ENOENT" });

    await expect(
      inspectProcessIdentity(42, "linux", {
        readProcessStat: async () => {
          throw missing;
        },
        probeProcess: () => "dead",
      }),
    ).resolves.toEqual({ status: "dead" });
  });

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
