import { expect, it } from "vitest";
import { coveringMount, parseStorageMounts } from "../../src/core/storage-mounts.js";

it("distinguishes Linux copy-on-write, propagation and remote mounts without retaining a source", () => {
  const mounts = parseStorageMounts(
    "linux",
    [
      "1 0 8:1 / / rw - ext4 /dev/test rw",
      "2 1 8:2 /sub /data rw shared:8 - btrfs /dev/example rw",
      "3 1 0:8 / /data/shared\\040disk ro - cifs //private.invalid/secret ro",
    ].join("\n"),
  );
  expect(coveringMount("/data/cache", mounts)).toMatchObject({
    filesystem: "btrfs",
    extentSharing: "possible",
    sharedPropagation: true,
  });
  expect(coveringMount("/data/shared disk/project", mounts)).toMatchObject({
    access: "network",
    readOnly: true,
  });
  expect(JSON.stringify(mounts)).not.toContain("private.invalid");
});
it("recognizes APFS, AFP, SMB and autofs without probing mountpoints", () => {
  const mounts = parseStorageMounts(
    "darwin",
    "disk on / (apfs, sealed, local, read-only)\nmap on /net (autofs, automounted)\nsource on /Volumes/A (afpfs, nodev)\nsource on /Volumes/B (smbfs, nodev)",
  );
  expect(mounts.map((m) => m.access)).toEqual(["local", "automount", "network", "network"]);
  expect(mounts[0]).toMatchObject({ extentSharing: "possible", sharedPropagation: null });
});
it("fails closed on unsupported or incomplete mount metadata", () => {
  for (const value of [
    "",
    "unknown",
    "/dev/x on /volume (apfs, local)",
    "/dev/x on / (apfs, local)\ntruncated",
  ])
    expect(() => parseStorageMounts("darwin", value)).toThrow();
});
