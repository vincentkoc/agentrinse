import type { BigIntStats } from "node:fs";
import { describe, expect, it } from "vitest";
import { gitFileObservation, GitIdentityLedger } from "../../src/rules/git/inventory-bytes.js";

describe("Git census file identity accounting", () => {
  it("omits a shrinking identity from every unique group and from cross-owner merges", () => {
    const stats = {
      dev: 1n,
      ino: 1n,
      size: 8192n,
      blocks: 16n,
      nlink: 3n,
      mode: 1n,
      mtimeNs: 1n,
      ctimeNs: 1n,
    } as BigIntStats;
    const ledger = new GitIdentityLedger(),
      sibling = new GitIdentityLedger();
    ledger.observe(gitFileObservation("temporary-pack-name", stats));
    sibling.observe(gitFileObservation("pack", { ...stats, size: 1n, blocks: 1n } as BigIntStats));
    ledger.merge(sibling);
    expect(ledger.report()).toMatchObject({
      uniqueFiles: { files: 0 },
      changedIdentitiesOmitted: 1,
      temporaryNames: { observedNames: 1, omittedChangedNames: 1, uniqueIdentities: { files: 0 } },
    });
  });
  it("accounts for over 400,000 names with exact byte totals", () => {
    const ledger = new GitIdentityLedger(),
      base = {
        dev: 1n,
        ino: 1n,
        size: 2n ** 45n,
        blocks: 8n,
        nlink: 1n,
        mode: 1n,
        mtimeNs: 1n,
        ctimeNs: 1n,
      } as BigIntStats;
    const first = gitFileObservation("pack", base);
    for (let i = 0; i < 400001; i++) ledger.observe({ ...first, key: "1:" + i });
    const totals = ledger.report().uniqueFiles;
    expect(totals).toEqual({
      files: 400001,
      logicalBytes: String(400001n * 2n ** 45n),
      allocatedBytes: String(400001n * 4096n),
    });
  });
});
