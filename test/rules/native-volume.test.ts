import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { inspectNativeVolume } from "../../src/rules/storage/native-volume.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";

it("reads native counters only for explicitly mounted local APFS or Btrfs filesystems", async () => {
  const path = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-volume-")));
  const base = parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
  const mount = { ...base[0]!, path, filesystem: "apfs" };
  const run = vi.fn(async (command: string) => ({
    stdout: command.endsWith("diskutil")
      ? "fixture-plist"
      : JSON.stringify({
          Snapshots: [{ Purgeable: true }, { Purgeable: false }, {}],
          APFSContainerFree: 200,
          APFSContainerSize: 400,
        }),
    stderr: "",
  }));
  expect(
    await inspectNativeVolume(path, "darwin", async () => [...base, mount], run),
  ).toMatchObject({
    status: "partial",
    data: {
      containerFreeBytes: "200",
      containerBytes: "400",
      snapshots: 3,
      purgeable: 1,
      nonPurgeable: 1,
      purgeabilityUnknown: 1,
    },
  });
  expect(run).toHaveBeenCalledWith(
    "/usr/bin/plutil",
    expect.any(Array),
    expect.objectContaining({ input: "fixture-plist" }),
  );
  run.mockClear();
  await mkdir(join(path, "sub"));
  for (const [target, table] of [
    [join(path, "sub"), [...base, mount]],
    [path, [...base, { ...mount, access: "network" as const }]],
    [path, undefined],
  ] as const) {
    expect(
      await inspectNativeVolume(
        target,
        "darwin",
        async () => (table ? [...table] : undefined),
        run,
      ),
    ).toMatchObject({ status: "unavailable" });
  }
  expect(run).not.toHaveBeenCalled();
  const btrfs = [...base, { ...mount, filesystem: "btrfs" }];
  const usage = vi.fn(async () => ({
    stdout: "Device size: 100\nDevice allocated: 60\nDevice unallocated: 40\n",
    stderr: "",
  }));
  expect(await inspectNativeVolume(path, "linux", async () => btrfs, usage)).toMatchObject({
    status: "observed",
    data: { deviceBytes: "100", allocatedBytes: "60", unallocatedBytes: "40" },
  });
  usage.mockResolvedValueOnce({ stdout: "Device allocated: 60\n", stderr: "" });
  expect(await inspectNativeVolume(path, "linux", async () => btrfs, usage)).toMatchObject({
    status: "unavailable",
  });
  const mountLine = "1 0 8:1 / / rw - ext4 /dev/example rw\n";
  const table = (id: number) =>
    parseStorageMounts("linux", mountLine + `${id} 1 0:42 / ${path} rw - btrfs /dev/example rw`);
  const changing = vi.fn().mockResolvedValueOnce(table(7)).mockResolvedValueOnce(table(8));
  expect(await inspectNativeVolume(path, "linux", changing, usage)).toMatchObject({
    status: "unavailable",
  });
  const unreadableInfo = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "info") throw new Error("capacity unavailable");
    return { stdout: args[0] === "apfs" ? "fixture" : '{"Snapshots":[]}', stderr: "" };
  });
  expect(
    await inspectNativeVolume(path, "darwin", async () => [...base, mount], unreadableInfo),
  ).toMatchObject({ status: "partial", data: { snapshots: 0, containerBytes: null } });
});
