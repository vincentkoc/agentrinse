export type Location = {
  id: string;
  owner: string;
  relative: string;
  scope: "direct" | "retained" | "image" | "file-group";
  base?: "system";
  optIn?: true;
  selectFile?: (name: string) => boolean;
  reason: string;
  measureTree?: true;
  platform?: "darwin" | "linux";
};

export function storageFamily(scope: Location["scope"]): "developer" | "retained" | "vm" {
  if (scope === "image") return "vm";
  if (scope === "retained" || scope === "file-group") return "retained";
  return "developer";
}

export function locations(
  owner: string,
  scope: Location["scope"],
  reason: string,
  paths: Readonly<Record<string, string>>,
  options: Pick<Location, "platform" | "optIn" | "base"> = {},
): Location[] {
  return Object.entries(paths).map(([id, relative]) => ({
    id,
    owner,
    scope,
    reason,
    relative,
    ...options,
  }));
}
