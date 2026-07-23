import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findMountBoundaries } from "../../src/core/mount-boundaries.js";

describe("findMountBoundaries", () => {
  it("detects same-device Linux bind mount paths", async () => {
    const target = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-mount-")));
    const nested = join(target, "nested bind");
    const mountInfo = [
      "21 1 8:1 / / rw - ext4 /dev/root rw",
      `22 21 8:1 /source ${nested.replaceAll(" ", "\\040")} rw - ext4 /dev/root rw`,
    ].join("\n");

    await expect(
      findMountBoundaries(target, {
        platform: "linux",
        linuxMountInfo: mountInfo,
      }),
    ).resolves.toEqual({
      status: "blocked",
      paths: [nested],
    });
  });

  it("detects macOS mount paths and fails closed on warnings", async () => {
    const target = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-mount-")));
    const nested = join(target, "volume");

    await expect(
      findMountBoundaries(target, {
        platform: "darwin",
        runMount: async () => ({
          stdout: `/dev/disk1 on / (apfs, local)\nmap on ${nested} (autofs)\n`,
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      paths: [nested],
    });

    await expect(
      findMountBoundaries(target, {
        platform: "darwin",
        runMount: async () => ({
          stdout: "",
          stderr: "incomplete",
        }),
      }),
    ).resolves.toMatchObject({ status: "unknown" });
  });
});
