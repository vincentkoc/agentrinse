import { join } from "node:path";
import type { AdapterId } from "../config/schema.js";
import type { AuditContext } from "../contracts/adapter.js";
import type { Finding } from "../contracts/finding.js";
import type { ResourceKind, ResourceSnapshot } from "../contracts/resource.js";

export type ProviderAdapterId = Exclude<AdapterId, "git" | "docker" | "runtime">;

export type ProviderResourceSpec = {
  relativePath: string;
  displayName: string;
  kind: ResourceKind;
};

export type ProviderSpec = {
  id: ProviderAdapterId;
  displayName: string;
  defaultRoot(home: string, platform: NodeJS.Platform): string;
  resources: ProviderResourceSpec[];
  environmentRoot?: string;
  classify?(context: AuditContext, resource: ResourceSnapshot): Finding | undefined;
};

export function homePath(...segments: string[]) {
  return (home: string): string => join(home, ...segments);
}
