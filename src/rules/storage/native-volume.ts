import { runBoundedCommand } from "../../core/bounded-command.js";
import {
  coveringMount,
  mountIndex,
  sameStorageMount,
  readStorageMounts,
} from "../../core/storage-mounts.js";
import { observeStoragePath } from "../../core/storage-observation.js";

const limits = { maxOutputBytes: 512 * 1024, timeoutMs: 3000 };
type Reader = typeof runBoundedCommand;
type Snapshot = { Purgeable?: boolean };

async function diskutilPlist(args: string[], run: Reader): Promise<Record<string, unknown>> {
  const plist = await run("/usr/sbin/diskutil", args, limits);
  if (plist.stderr.trim()) throw new Error("incomplete disk inventory");
  const json = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    ...limits,
    input: plist.stdout,
  });
  if (json.stderr.trim()) throw new Error("invalid disk inventory");
  const data: unknown = JSON.parse(json.stdout);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid disk inventory");
  return data as Record<string, unknown>;
}

function byteCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null;
}

async function apfsSnapshots(path: string, run: Reader) {
  const rows = (await diskutilPlist(["apfs", "listSnapshots", "-plist", path], run)).Snapshots;
  if (
    !Array.isArray(rows) ||
    !rows.every((row) => row && typeof row === "object" && !Array.isArray(row))
  )
    throw new Error("invalid snapshot inventory");
  const snapshots = rows as Snapshot[];
  const purgeable = snapshots.filter((row) => row.Purgeable === true).length;
  const nonPurgeable = snapshots.filter((row) => row.Purgeable === false).length;
  const info = await diskutilPlist(["info", "-plist", path], run).catch(
    () => ({}) as Record<string, unknown>,
  );
  return {
    containerFreeBytes: byteCount(info.APFSContainerFree),
    containerBytes: byteCount(info.APFSContainerSize),
    snapshots: snapshots.length,
    purgeable,
    nonPurgeable,
    purgeabilityUnknown: snapshots.length - purgeable - nonPurgeable,
  };
}

async function btrfsUsage(path: string, run: Reader) {
  const args = ["filesystem", "usage", "--raw", path];
  const result = await run("/usr/bin/btrfs", args, limits).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return run("/usr/sbin/btrfs", args, limits);
  });
  if (result.stderr.trim()) throw new Error("incomplete filesystem usage");
  const fields = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(Device size|Device allocated|Device unallocated):\s*(\d+)\s*$/u.exec(line);
    if (match) {
      if (fields.has(match[1]!)) throw new Error("duplicate filesystem counter");
      fields.set(match[1]!, match[2]!);
    }
  }
  if (fields.size !== 3) throw new Error("missing filesystem counters");
  return {
    deviceBytes: fields.get("Device size")!,
    allocatedBytes: fields.get("Device allocated")!,
    unallocatedBytes: fields.get("Device unallocated")!,
  };
}

export async function inspectNativeVolume(
  path: string,
  platform: NodeJS.Platform,
  readMounts: typeof readStorageMounts = readStorageMounts,
  run: Reader = runBoundedCommand,
) {
  const mounts = await readMounts(platform);
  const mount = mounts && mountIndex(mounts).get(path);
  const filesystem = mount?.filesystem ?? null;
  const unknown = { path, filesystem, status: "unavailable" as const };
  if (!mount || !mounts || coveringMount(path, mounts)?.access !== "local") return unknown;
  if (
    !(platform === "darwin" && filesystem === "apfs") &&
    !(platform === "linux" && filesystem === "btrfs")
  )
    return unknown;
  const before = await observeStoragePath(path, mounts);
  if (!before.stats?.isDirectory()) return unknown;
  try {
    const data =
      filesystem === "apfs" ? await apfsSnapshots(path, run) : await btrfsUsage(path, run);
    const current = await readMounts(platform);
    const active = current && mountIndex(current).get(path);
    if (
      !current ||
      !active ||
      !sameStorageMount(mount, active) ||
      coveringMount(path, current)?.access !== "local"
    )
      return unknown;
    const after = await observeStoragePath(path, current);
    if (
      !after.stats?.isDirectory() ||
      before.stats.dev !== after.stats.dev ||
      before.stats.ino !== after.stats.ino
    )
      return unknown;
    const partial =
      "snapshots" in data &&
      (data.containerBytes === null ||
        data.containerFreeBytes === null ||
        data.purgeabilityUnknown > 0);
    return {
      path,
      filesystem,
      status: partial ? ("partial" as const) : ("observed" as const),
      data,
    };
  } catch {
    return unknown;
  }
}
