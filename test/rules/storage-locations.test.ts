import auditedLocations from "../fixtures/storage-audit-locations.json" with { type: "json" };
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

it("preserves the inspection method for every location in the storage audit", () => {
  const catalog = storageRuleCatalog();
  const fixed = new Map(
    catalog.locations.filter((rule) => rule.platform !== "linux").map((rule) => [rule.path, rule]),
  );
  const supplied = new Set(catalog.suppliedLocations.map((rule) => "@" + rule.id));
  const locations = Object.values(auditedLocations).flat();
  expect(new Set(locations).size).toBe(151);
  expect(locations).toHaveLength(151);

  for (const [method, paths] of Object.entries(auditedLocations)) {
    for (const path of paths) {
      if (method === "supplied") {
        expect(supplied.has(path), path).toBe(true);
        continue;
      }
      const rule = fixed.get(path);
      expect(rule, path).toBeDefined();
      const selection =
        method === "system" ? "system" : method === "sensitive" ? "explicit" : "default";
      const scope = method === "direct" || method === "tree" ? "direct" : "retained";
      expect(rule, path).toMatchObject({ scope, selection, treeMeasurement: method === "tree" });
    }
  }
});
