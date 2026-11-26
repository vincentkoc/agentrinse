import { realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { runBoundedCommand } from "../../core/bounded-command.js";
import { coveringMount, type StorageMount } from "../../core/storage-mounts.js";
import {
  observeStoragePath,
  sameObservation,
  type DirectEntry,
} from "../../core/storage-observation.js";

const identifier = z.string().regex(/^(?:0|[1-9]\d*)$/u);
export const directoryIdentity = z.object({
  dev: identifier,
  ino: identifier,
  stable: z
    .object({
      path: z.string().refine(isAbsolute),
      birthtimeNs: z.string().regex(/^[1-9]\d*$/u),
      volume: z.string().min(1),
    })
    .optional(),
});
type Identity = z.infer<typeof directoryIdentity>;
type VolumeReader = (path: string) => Promise<string | undefined>;
// Query only the already-observed local disk, never a mount source from a receipt.
async function volumeUuid(path: string) {
  if (process.platform !== "darwin") return;
  const options = { timeoutMs: 1500, maxOutputBytes: 128 * 1024, env: {} };
  try {
    const disk = (
      await runBoundedCommand("/usr/bin/stat", ["-f", "%Sd", path], options)
    ).stdout.trim();
    if (!/^disk\d+(?:s\d+)*$/u.test(disk)) return;
    const info = await runBoundedCommand("/usr/sbin/diskutil", ["info", "-plist", disk], options);
    const match = /<key>VolumeUUID<\/key>\s*<string>([a-f0-9-]+)<\/string>/iu.exec(info.stdout);
    const uuid = match?.[1]?.toLowerCase();
    return uuid && z.uuid().safeParse(uuid).success ? "uuid:" + uuid : undefined;
  } catch {
    return;
  }
}

export async function currentStagingIdentity(
  entry: DirectEntry,
  owner: { rootIdentity: Identity; payloadIdentity: Identity },
  mounts: StorageMount[],
  legacyBeforeNs: bigint,
  readVolume: VolumeReader = volumeUuid,
): Promise<boolean> {
  const payload = join(entry.path, "payload");
  if (coveringMount(payload, mounts) !== coveringMount(entry.path, mounts)) return false;
  const paths = [entry.path, payload];
  const expected = [owner.rootIdentity, owner.payloadIdentity];
  const actual = await Promise.all(paths.map((path) => observeStoragePath(path, mounts)));
  const root = actual[0]?.stats,
    child = actual[1]?.stats;
  if (
    !root?.isDirectory() ||
    !child?.isDirectory() ||
    !sameObservation(entry.stats, root) ||
    child.dev !== root.dev ||
    child.uid !== root.uid
  )
    return false;
  let uuid: Promise<string | undefined> | undefined;
  async function matches(path: string, stat: BigIntStats, target: Identity) {
    if (target.dev !== String(stat.dev) || target.ino !== String(stat.ino)) return false;
    const stable = target.stable;
    if (!stable) return stat.birthtimeNs <= 0n || stat.birthtimeNs <= legacyBeforeNs;
    if (
      stable.path !== path ||
      stable.birthtimeNs !== String(stat.birthtimeNs) ||
      (await realpath(path)) !== stable.path
    )
      return false;
    if (stable.volume === "device:" + target.dev) return true;
    if (!stable.volume.startsWith("uuid:")) return false;
    uuid ??= readVolume(entry.path);
    return stable.volume === (await uuid);
  }
  try {
    if (
      !(await matches(paths[0]!, root, expected[0]!)) ||
      !(await matches(paths[1]!, child, expected[1]!))
    )
      return false;
    const after = await Promise.all(paths.map((path) => observeStoragePath(path, mounts)));
    return Boolean(
      after[0]?.stats &&
      after[1]?.stats &&
      sameObservation(root, after[0].stats) &&
      sameObservation(child, after[1].stats),
    );
  } catch {
    return false;
  }
}
