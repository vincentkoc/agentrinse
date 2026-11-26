import { lstatSync, type BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";

type ChangeStamp = Pick<BigIntStats, "dev" | "ino" | "mtimeNs" | "ctimeNs">;

function stamp(stats: BigIntStats): ChangeStamp {
  return { dev: stats.dev, ino: stats.ino, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

function matches(stats: BigIntStats, before: ChangeStamp): boolean {
  return (
    stats.dev === before.dev &&
    stats.ino === before.ino &&
    stats.mtimeNs === before.mtimeNs &&
    stats.ctimeNs === before.ctimeNs
  );
}

// A bounded artifact measurement supplies these exact paths. The final check never enumerates them again.
export class DirectoryChangeProof {
  private readonly directories = new Map<string, ChangeStamp>();
  private file: { path: string; stamp: ChangeStamp } | undefined;

  async beforeRead(path: string): Promise<ChangeStamp> {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory()) throw new Error("artifact directory changed before enumeration");
    return stamp(stats);
  }

  async afterRead(path: string, before: ChangeStamp): Promise<void> {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || !matches(stats, before))
      throw new Error("artifact directory changed during enumeration");
    this.directories.set(path, before);
  }

  async watchDeclaration(path: string): Promise<void> {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n)
      throw new Error("artifact cache declaration changed");
    this.file = { path, stamp: stamp(stats) };
  }

  unchanged(root: string): boolean {
    if (!this.directories.has(root)) return false;
    try {
      for (const [path, before] of this.directories) {
        const stats = lstatSync(path, { bigint: true });
        if (!stats.isDirectory() || !matches(stats, before)) return false;
      }
      if (this.file) {
        const stats = lstatSync(this.file.path, { bigint: true });
        if (!stats.isFile() || stats.nlink !== 1n || !matches(stats, this.file.stamp)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
