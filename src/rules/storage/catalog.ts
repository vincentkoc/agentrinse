import { join } from "node:path";
import type { Location } from "./location.js";
import { packageStores } from "./package-stores.js";
import { buildAndBrowserCaches } from "./build-and-browser-caches.js";
import { agentAndSystemStorage } from "./agent-and-system-storage.js";

export const storageLocations: readonly Location[] = [
  ...packageStores,
  ...buildAndBrowserCaches,
  ...agentAndSystemStorage,
];

export function localStorageLocations(home: string, platform: NodeJS.Platform) {
  return storageLocations
    .filter((l) => !l.platform || l.platform === platform)
    .map((l) => ({ ...l, path: join(home, l.relative) }));
}
