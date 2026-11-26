import { open } from "node:fs/promises";
import { posix } from "node:path";
import { runBoundedCommand } from "./bounded-command.js";
import { isPathInside } from "./safety.js";

export type StorageMount = {
  path: string;
  filesystem: string;
  access: "local" | "network" | "automount" | "unknown";
  readOnly: boolean;
  extentSharing: "possible" | "unknown";
  sharedPropagation: boolean | null;
};
const mountLimit = 2 * 1024 * 1024;
const local = new Set([
  "apfs",
  "btrfs",
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "hfs",
  "hfsplus",
  "tmpfs",
  "ramfs",
  "zfs",
  "f2fs",
  "overlay",
  "ufs",
]);
const network = new Set([
  "afp",
  "afpfs",
  "smbfs",
  "smb3",
  "cifs",
  "nfs",
  "nfs4",
  "sshfs",
  "fuse.sshfs",
  "9p",
  "virtiofs",
  "davfs",
  "webdav",
  "ceph",
  "glusterfs",
]);

export function parseStorageMounts(platform: NodeJS.Platform, input: string): StorageMount[] {
  if (!["darwin", "linux"].includes(platform) || Buffer.byteLength(input) > mountLimit)
    throw new Error("Unsupported mount table");
  const result: StorageMount[] = [];
  for (const line of input.trimEnd().split("\n")) {
    let path: string | undefined,
      fs: string | undefined,
      flags: string[] = [];
    let shared: boolean | null = null;
    if (platform === "linux") {
      const sides = line.split(" - ");
      const fields = sides[0]?.split(" ") ?? [];
      if (
        sides.length !== 2 ||
        fields.length < 6 ||
        sides[1]?.split(" ").length !== 3 ||
        !fields[5]?.split(",").some((flag) => flag === "rw" || flag === "ro") ||
        !/^\d+$/u.test(fields[0] ?? "") ||
        !/^\d+:\d+$/u.test(fields[2] ?? "")
      )
        throw new Error("Invalid mountinfo entry");
      path = fields[4];
      fs = sides[1]?.split(" ")[0];
      flags = (fields[5] ?? "").split(",");
      shared = fields.slice(6).some((field) => /^shared:\d+$/u.test(field));
    } else {
      if (line.split(" on ").length !== 2) throw new Error("Ambiguous mount entry");
      const match =
        /^.+? on (\/.+) \(([^()]+)\)$/u.exec(line) ?? /^.+? on (\/) \(([^()]+)\)$/u.exec(line);
      if (!match) throw new Error("Invalid mount entry");
      path = match[1];
      flags = match[2]!.split(/,\s*/u);
      fs = flags.shift();
    }
    if (!path?.startsWith("/") || !fs || !/^[a-zA-Z0-9._-]+$/u.test(fs))
      throw new Error("Invalid mount metadata");
    path = path.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );
    if (/\p{Cc}/u.test(path) || posix.normalize(path) !== path)
      throw new Error("Invalid mount path");
    result.push({
      path,
      filesystem: fs,
      access:
        fs === "autofs"
          ? "automount"
          : network.has(fs)
            ? "network"
            : local.has(fs)
              ? "local"
              : "unknown",
      readOnly: flags.includes("ro") || flags.includes("read-only"),
      extentSharing: ["apfs", "btrfs", "zfs", "overlay", "xfs"].includes(fs)
        ? "possible"
        : "unknown",
      sharedPropagation: shared,
    });
  }
  if (!result.some((m) => m.path === "/")) throw new Error("Missing root mount");
  return result;
}

export async function readStorageMounts(
  platform: NodeJS.Platform,
): Promise<StorageMount[] | undefined> {
  try {
    if (platform === "darwin") {
      const { stdout, stderr } = await runBoundedCommand("/sbin/mount", [], {
        timeoutMs: 3000,
        maxOutputBytes: mountLimit,
      });
      if (stderr) return;
      return parseStorageMounts(platform, stdout);
    }
    if (platform === "linux") {
      const file = await open("/proc/self/mountinfo", "r");
      try {
        const bytes = Buffer.alloc(mountLimit + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > mountLimit) return;
        return parseStorageMounts(platform, bytes.toString("utf8", 0, length));
      } finally {
        await file.close();
      }
    }
  } catch {
    /* Unknown mount coverage keeps all filesystem probes disabled. */
  }
  return undefined;
}

// Use only the kernel table here: resolving or statting a path can wake an automounter.
export function coveringMount(path: string, mounts: StorageMount[]): StorageMount | undefined {
  const ancestors = mounts.filter((m) => isPathInside(m.path, path));
  // Unknown/remote ancestry stays opaque even if a nested entry looks local.
  return (
    ancestors
      .filter((m) => m.access !== "local")
      .sort((a, b) => b.path.length - a.path.length)[0] ??
    ancestors.sort((a, b) => b.path.length - a.path.length)[0]
  );
}
