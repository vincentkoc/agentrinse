export type Location = {
  id: string;
  owner: string;
  relative: string;
  scope: "direct" | "retained" | "image";
  reason: string;
  measureTree?: true;
  platform?: "darwin" | "linux";
};

export function storageFamily(scope: Location["scope"]): "developer" | "retained" | "vm" {
  if (scope === "image") return "vm";
  if (scope === "retained") return "retained";
  return "developer";
}
