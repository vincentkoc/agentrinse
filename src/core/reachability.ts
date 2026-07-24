import { isAbsolute, relative, resolve } from "node:path";

import type { RootEvidence } from "../contracts/finding.js";
import type { ResourceRef } from "../contracts/resource.js";

type ReachabilityEvidence = Omit<RootEvidence, "observedAt"> & {
  expiresAt?: string;
};

export type ReachabilityRoot = ReachabilityEvidence & {
  path: string;
  scope?: "exact" | "subtree";
};

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

export class ReachabilityIndex {
  private readonly roots = new Map<string, ReachabilityRoot>();
  private readonly resourceRoots = new Map<string, ReachabilityEvidence>();
  private readonly gitRefRoots = new Map<string, ReachabilityEvidence>();
  private readonly globalRoots = new Map<string, ReachabilityEvidence>();

  add(root: ReachabilityRoot): void {
    const path = resolve(root.path);
    const key = `${root.code}\0${root.source}\0${path}\0${root.scope ?? "exact"}\0${root.evidenceRef ?? ""}`;
    this.roots.set(key, { ...root, path });
  }

  addGlobal(root: Omit<RootEvidence, "observedAt">): void {
    const key = `${root.code}\0${root.source}\0${root.evidenceRef ?? ""}`;
    this.globalRoots.set(key, root);
  }

  addResource(resourceId: string, root: ReachabilityEvidence): void {
    const key = `${resourceId}\0${root.code}\0${root.source}\0${root.evidenceRef ?? ""}`;
    this.resourceRoots.set(key, root);
  }

  addGitRef(gitRef: string, root: ReachabilityEvidence): void {
    const key = `${gitRef}\0${root.code}\0${root.source}\0${root.evidenceRef ?? ""}`;
    this.gitRefRoots.set(key, root);
  }

  private isCurrent(root: ReachabilityEvidence, observedAt: string): boolean {
    return root.expiresAt === undefined || Date.parse(root.expiresAt) > Date.parse(observedAt);
  }

  private evidence(root: ReachabilityEvidence, observedAt: string): RootEvidence {
    const { expiresAt: _expiresAt, ...evidence } = root;
    return { ...evidence, observedAt };
  }

  private sort(roots: RootEvidence[]): RootEvidence[] {
    return roots.sort((left, right) => {
      const byCode = left.code.localeCompare(right.code);
      if (byCode !== 0) {
        return byCode;
      }
      const bySource = left.source.localeCompare(right.source);
      return bySource !== 0
        ? bySource
        : (left.evidenceRef ?? "").localeCompare(right.evidenceRef ?? "");
    });
  }

  rootsFor(path: string, observedAt: string): RootEvidence[] {
    const target = resolve(path);
    const matchingRoots = [...this.roots.values()]
      .filter((root) => this.isCurrent(root, observedAt))
      .filter((root) =>
        root.scope === "subtree" ? isInside(root.path, target) : isInside(target, root.path),
      )
      .map(({ path: _path, scope: _scope, ...root }) => this.evidence(root, observedAt));
    const globalRoots = [...this.globalRoots.values()]
      .filter((root) => this.isCurrent(root, observedAt))
      .map((root) => this.evidence(root, observedAt));

    return this.sort([...matchingRoots, ...globalRoots]);
  }

  rootsForResource(
    resource: ResourceRef,
    facts: Record<string, unknown>,
    observedAt: string,
  ): RootEvidence[] {
    const roots =
      resource.path === undefined
        ? this.rootsFor("/", observedAt)
        : this.rootsFor(resource.path, observedAt);
    for (const [key, root] of this.resourceRoots) {
      if (key.startsWith(`${resource.id}\0`) && this.isCurrent(root, observedAt)) {
        roots.push(this.evidence(root, observedAt));
      }
    }

    const branch = typeof facts.branch === "string" ? facts.branch : undefined;
    const upstream = typeof facts.upstream === "string" ? facts.upstream : undefined;
    for (const [key, root] of this.gitRefRoots) {
      const gitRef = key.slice(0, key.indexOf("\0"));
      const matchesBranch =
        branch === gitRef ||
        (gitRef.startsWith("refs/heads/") && branch === gitRef.slice("refs/heads/".length));
      const matchesUpstream =
        upstream === gitRef ||
        (gitRef.startsWith("refs/remotes/") && upstream === gitRef.slice("refs/remotes/".length));
      if ((matchesBranch || matchesUpstream) && this.isCurrent(root, observedAt)) {
        roots.push(this.evidence(root, observedAt));
      }
    }
    return this.sort(roots);
  }

  size(): number {
    return (
      this.roots.size + this.resourceRoots.size + this.gitRefRoots.size + this.globalRoots.size
    );
  }
}
