import { isAbsolute, relative, resolve } from "node:path";

import type { RootEvidence } from "../contracts/finding.js";

export type ReachabilityRoot = Omit<RootEvidence, "observedAt"> & {
  path: string;
};

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export class ReachabilityIndex {
  private readonly roots = new Map<string, ReachabilityRoot>();

  add(root: ReachabilityRoot): void {
    const path = resolve(root.path);
    const key = `${root.code}\0${root.source}\0${path}\0${root.evidenceRef ?? ""}`;
    this.roots.set(key, { ...root, path });
  }

  rootsFor(path: string, observedAt: string): RootEvidence[] {
    const target = resolve(path);
    return [...this.roots.values()]
      .filter((root) => isInside(target, root.path))
      .map(({ path: _path, ...root }) => ({ ...root, observedAt }))
      .sort((left, right) => {
        const byCode = left.code.localeCompare(right.code);
        return byCode !== 0
          ? byCode
          : (left.evidenceRef ?? "").localeCompare(right.evidenceRef ?? "");
      });
  }

  size(): number {
    return this.roots.size;
  }
}
