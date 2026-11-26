import type { BigIntStats } from "node:fs";

export type GitFileKind =
  | "temporary-pack-name"
  | "temporary-index-name"
  | "other-temporary-name"
  | "pack"
  | "index"
  | "reverse-index"
  | "bitmap"
  | "keep"
  | "promisor"
  | "cruft-mtimes"
  | "multi-pack-index"
  | "other"
  | "bitmap-ref-tips-name"
  | "admin-locked"
  | "admin-prunable"
  | "admin-other"
  | "admin-unverified";

export function temporaryName(kind: GitFileKind) {
  return (
    kind === "temporary-pack-name" ||
    kind === "temporary-index-name" ||
    kind === "other-temporary-name"
  );
}

export function gitFileObservation(kind: GitFileKind, stats: BigIntStats) {
  return {
    kind,
    key: stats.dev + ":" + stats.ino,
    logical: stats.size,
    allocated: stats.blocks * 512n,
    links: stats.nlink,
    stamp: stats.mode + ":" + stats.mtimeNs + ":" + stats.ctimeNs,
  };
}
type Observation = ReturnType<typeof gitFileObservation>;
type Count = { files: number; logical: bigint; allocated: bigint };
const fresh = (): Count => ({ files: 0, logical: 0n, allocated: 0n });
export function serialCount(c: Count) {
  return {
    files: c.files,
    logicalBytes: c.logical.toString(),
    allocatedBytes: c.allocated.toString(),
  };
}
function add(c: Count, s: Observation) {
  c.files++;
  c.logical += s.logical;
  c.allocated += s.allocated;
}
export class GitNameTotals {
  private counts = new Map<GitFileKind, Count>();
  observe(s: Observation) {
    const c = this.counts.get(s.kind) ?? fresh();
    add(c, s);
    this.counts.set(s.kind, c);
  }
  report() {
    return Object.fromEntries([...this.counts].map(([kind, c]) => [kind, serialCount(c)]));
  }
}

type Identity = {
  first: Observation;
  aliases: number;
  tempNames: number;
  mixedKinds: boolean;
  changed: boolean;
  adminKind: string | null;
};

// Owner rows count names. This ledger counts physical file identities once across all owners and areas.
export class GitIdentityLedger {
  private files = new Map<string, Identity>();
  observe(s: Observation, changed = false) {
    this.combine({
      first: s,
      aliases: 1,
      tempNames: Number(temporaryName(s.kind)),
      mixedKinds: false,
      changed: changed || s.links < 1n,
      adminKind: s.kind.startsWith("admin-") ? s.kind : null,
    });
  }
  merge(owner: GitIdentityLedger) {
    for (const observation of owner.files.values()) this.combine(observation);
  }
  private combine(incoming: Identity) {
    const s = incoming.first,
      previous = this.files.get(s.key);
    if (!previous) {
      this.files.set(s.key, incoming);
      return;
    }
    previous.aliases += incoming.aliases;
    previous.tempNames += incoming.tempNames;
    previous.mixedKinds ||= incoming.mixedKinds || previous.first.kind !== s.kind;
    if (incoming.adminKind)
      previous.adminKind =
        previous.adminKind && previous.adminKind !== incoming.adminKind
          ? "multiple-admin-kinds"
          : incoming.adminKind;
    previous.changed ||=
      incoming.changed ||
      previous.first.stamp !== s.stamp ||
      previous.first.logical !== s.logical ||
      previous.first.allocated !== s.allocated ||
      previous.first.links !== s.links ||
      BigInt(previous.aliases) > s.links;
  }
  report() {
    const all = fresh(),
      admin = fresh(),
      allTemp = fresh(),
      tempOnly = fresh(),
      mixed = fresh(),
      unseen = fresh();
    const adminGroups = new Map<string, Count>();
    const kinds = new Map<string, Count>();
    let names = 0,
      tempNames = 0,
      repeatedNames = 0,
      changedIdentities = 0,
      omittedTempNames = 0;
    for (const f of this.files.values()) {
      names += f.aliases;
      repeatedNames += f.aliases - 1;
      tempNames += f.tempNames;
      if (f.changed) {
        changedIdentities++;
        omittedTempNames += f.tempNames;
        continue;
      }
      add(all, f.first);
      if (f.adminKind) {
        add(admin, f.first);
        const group = adminGroups.get(f.adminKind) ?? fresh();
        add(group, f.first);
        adminGroups.set(f.adminKind, group);
      }
      const kind = f.mixedKinds ? "multiple-kinds" : f.first.kind;
      const count = kinds.get(kind) ?? fresh();
      add(count, f.first);
      kinds.set(kind, count);
      if (f.tempNames === 0) continue;
      add(allTemp, f.first);
      if (f.tempNames < f.aliases) add(mixed, f.first);
      else if (BigInt(f.aliases) === f.first.links) add(tempOnly, f.first);
      else add(unseen, f.first);
    }
    return {
      observedNames: names,
      repeatedNames,
      changedIdentitiesOmitted: changedIdentities,
      uniqueFiles: serialCount(all),
      byKind: Object.fromEntries([...kinds].map(([k, c]) => [k, serialCount(c)])),
      temporaryNames: {
        observedNames: tempNames,
        uniqueIdentities: serialCount(allTemp),
        omittedChangedNames: omittedTempNames,
        allLinksAccountedForAndTemporary: serialCount(tempOnly),
        alsoHasNonTemporaryName: serialCount(mixed),
        unobservedLinks: serialCount(unseen),
      },
      missingAdminFiles: serialCount(admin),
      missingAdminByState: Object.fromEntries(
        [...adminGroups].map(([k, c]) => [k, serialCount(c)]),
      ),
      reclaimableBytes: null,
    };
  }
}
