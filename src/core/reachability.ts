import { isAbsolute, relative, resolve } from "node:path";

import type { RootEvidence } from "../contracts/finding.js";

export type ReachabilityRoot = Omit<RootEvidence, "observedAt"> & {
  path: string;
  scope?: "exact" | "subtree";
};

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export class ReachabilityIndex {
  private readonly roots = new Map<string, ReachabilityRoot>();
  private readonly globalRoots = new Map<string, Omit<RootEvidence, "observedAt">>();

  add(root: ReachabilityRoot): void {
    const path = resolve(root.path);
    const key = `${root.code}\0${root.source}\0${path}\0${root.scope ?? "exact"}\0${root.evidenceRef ?? ""}`;
    this.roots.set(key, { ...root, path });
  }

  addGlobal(root: Omit<RootEvidence, "observedAt">): void {
    const key = `${root.code}\0${root.source}\0${root.evidenceRef ?? ""}`;
    this.globalRoots.set(key, root);
  }

  rootsFor(path: string, observedAt: string): RootEvidence[] {
    const target = resolve(path);
    const matchingRoots = [...this.roots.values()]
      .filter((root) =>
        root.scope === "subtree" ? isInside(root.path, target) : isInside(target, root.path),
      )
      .map(({ path: _path, scope: _scope, ...root }) => ({ ...root, observedAt }));
    const globalRoots = [...this.globalRoots.values()].map((root) => ({
      ...root,
      observedAt,
    }));

    return [...matchingRoots, ...globalRoots].sort((left, right) => {
      const byCode = left.code.localeCompare(right.code);
      return byCode !== 0
        ? byCode
        : (left.evidenceRef ?? "").localeCompare(right.evidenceRef ?? "");
    });
  }

  size(): number {
    return this.roots.size + this.globalRoots.size;
  }
}
