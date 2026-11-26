import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { isPathInside } from "../../core/safety.js";
import { mountIndex, type StorageMount } from "../../core/storage-mounts.js";

const containers = [[".worktrees"], [".claude", "worktrees"]] as const;

export async function projectWorktreeRoots(owner: string, home: string, mounts: StorageMount[]) {
  const available: string[] = [];
  const withheld: string[] = [];
  const device = (await lstat(owner)).dev;
  const mountPaths = mountIndex(mounts);
  for (const parts of containers) {
    let current = owner;
    try {
      for (const part of parts) {
        current = join(current, part);
        if (mountPaths.has(current)) throw new Error("mounted path");
        const stats = await lstat(current);
        if (!stats.isDirectory() || stats.dev !== device || (await realpath(current)) !== current)
          throw new Error("unsafe project worktree container");
      }
      // The existing checkout scanner and byte counter cannot identify same-device bind mounts.
      if (
        isPathInside(current, home) ||
        mounts.some((mount) => mount.path.startsWith(current + sep))
      )
        throw new Error("unsafe project worktree container");
      available.push(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        withheld.push(current);
    }
  }
  return { available, withheld };
}
