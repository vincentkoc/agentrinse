import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import { storageLocations } from "../rules/storage/catalog.js";
import { ownerEvidence } from "../rules/storage/owner-evidence.js";
import { suppliedLocations } from "../rules/storage/supplied-locations.js";

export function storageRuleCatalog() {
  const locations = storageLocations.map((rule) => ({
    id: rule.id,
    owner: rule.owner,
    platform: rule.platform ?? "all",
    path: (rule.base === "system" ? "/" : "~/") + rule.relative,
    scope: rule.scope,
    selection: rule.base === "system" ? "system" : rule.optIn ? "explicit" : "default",
    treeMeasurement: rule.measureTree === true,
    reason: rule.reason,
  }));
  return { locations, suppliedLocations, ownerEvidence };
}

export function executeStorageRulesCommand(json: boolean): string {
  const data = storageRuleCatalog();
  const stamp = new Date().toISOString();
  if (json)
    return jsonDocument(
      createCommandEnvelope({
        command: "storage-rules",
        startedAt: stamp,
        completedAt: stamp,
        status: "ok",
        data,
      }),
    );
  return (
    [
      ...data.locations.map(
        (rule) => `${rule.id}  ${rule.path}  ${rule.scope}  ${rule.platform}  ${rule.selection}`,
      ),
      ...data.suppliedLocations.map(
        (rule) => `${rule.id}  --at ${rule.id}=<absolute-path>  retained  ${rule.reason}`,
      ),
      ...data.ownerEvidence.map(
        (rule) =>
          `${rule.id}  ${rule.owner}  ${"inventory" in rule ? rule.inventory + "  " : ""}${rule.requires}`,
      ),
    ].join("\n") + "\n"
  );
}
