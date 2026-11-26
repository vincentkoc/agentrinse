import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// Git's gitdir backlink maps an admin directory to its registered checkout.
// The checkout name is not necessarily the name Git assigned its admin slot.
export async function registeredCheckoutPath(admin: string): Promise<string | undefined> {
  if ((await realpath(admin)) !== admin) return;
  const backlink = join(admin, "gitdir");
  const stats = await lstat(backlink);
  if (!stats.isFile() || stats.size < 1 || stats.size >= 16_384) return;
  const handle = await open(
    backlink,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size
    )
      return;
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== opened.size) return;
    const value = buffer.toString("utf8", 0, bytesRead).replace(/\r?\n$/u, "");
    if (basename(value) !== ".git") return;
    return dirname(isAbsolute(value) ? value : resolve(admin, value));
  } finally {
    await handle.close();
  }
}

export async function missingAdminSizes(common: string, missing: Set<string>, signal: AbortSignal) {
  const sizes = new Map<string, number>();
  const base = join(common, "worktrees");
  if ((await realpath(base)) !== base) return sizes;
  const slots = await opendir(base);
  let inspected = 0;
  for await (const slot of slots) {
    if (signal.aborted || ++inspected > 50_000) break;
    if (!slot.isDirectory()) continue;
    const admin = join(base, slot.name);
    try {
      if (!(await lstat(admin)).isDirectory()) continue;
      const path = await registeredCheckoutPath(admin);
      if (!path || !missing.has(path)) continue;
      let bytes = 0;
      let count = 0;
      for await (const file of await opendir(admin)) {
        if (signal.aborted || ++count > 256) throw new Error("admin measurement incomplete");
        if (file.isFile()) {
          const stats = await lstat(join(admin, file.name));
          if (stats.isFile()) bytes += stats.size;
        }
      }
      sizes.set(path, bytes);
    } catch {
      // A disappearing slot, unsafe backlink or failed measurement stays unknown.
    }
  }
  return sizes;
}
