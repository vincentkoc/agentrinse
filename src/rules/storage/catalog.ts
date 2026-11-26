import { toolchainsLocations } from "./toolchains-locations.js";
import { mobileLocations } from "./mobile-locations.js";
import { agentsLocations } from "./agents-locations.js";
import { packagesLocations } from "./packages-locations.js";
import { desktopLocations } from "./desktop-locations.js";
import { appleSystemLocations } from "./apple-system-locations.js";
import { join } from "node:path";
import type { Location } from "./location.js";
import { packageStores } from "./package-stores.js";
import { buildAndBrowserCaches } from "./build-and-browser-caches.js";
import { agentAndSystemStorage } from "./agent-and-system-storage.js";

export const storageLocations: readonly Location[] = [
  ...packageStores,
  ...buildAndBrowserCaches,
  ...agentAndSystemStorage,
  ...toolchainsLocations,
  ...mobileLocations,
  ...agentsLocations,
  ...packagesLocations,
  ...desktopLocations,
  ...appleSystemLocations,
];

export function localStorageLocations(home: string, platform: NodeJS.Platform, systemRoot = "/") {
  return storageLocations
    .filter((l) => !l.platform || l.platform === platform)
    .map((l) => ({ ...l, path: join(l.base === "system" ? systemRoot : home, l.relative) }));
}
