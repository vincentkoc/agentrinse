import { expect, it } from "vitest";
import { storageRuleCatalog } from "../../src/commands/storage-rules.js";
import { localStorageLocations } from "../../src/rules/storage/catalog.js";

it("gives each catalog rule a unique ID and each platform one literal path per location", () => {
  const catalog = storageRuleCatalog();
  const ids = [...catalog.locations, ...catalog.suppliedLocations, ...catalog.ownerEvidence].map(
    (rule) => rule.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  for (const platform of ["linux", "darwin"] as const) {
    const paths = localStorageLocations("/fixture/home", platform, "/fixture/system").map(
      (rule) => rule.path,
    );
    expect(new Set(paths).size).toBe(paths.length);
  }
  for (const rule of catalog.locations) {
    if (rule.scope !== "direct") expect(rule.treeMeasurement).toBe(false);
    if (rule.selection === "system") expect(rule.scope).toBe("retained");
  }
});
