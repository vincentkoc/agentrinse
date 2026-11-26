import { locations } from "./location.js";

export const appleSystemLocations = [
  ...locations(
    "CoreSimulator",
    "retained",
    "System-owned simulator assets, caches, images and runtime profiles",
    {
      "simulator.runtime-assets":
        "System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime",
      "simulator.system-caches": "Library/Developer/CoreSimulator/Caches",
      "simulator.system-images": "Library/Developer/CoreSimulator/Images",
      "simulator.runtime-profiles": "Library/Developer/CoreSimulator/Profiles/Runtimes",
    },
    { platform: "darwin", base: "system", optIn: true },
  ),
  ...locations(
    "Apple Software Update",
    "retained",
    "System-owned installer packages and update assets",
    {
      "apple.system-updates": "Library/Updates",
      "apple.update-assets": "System/Library/AssetsV2/com_apple_MobileAsset_macOSSoftwareUpdate",
    },
    { platform: "darwin", base: "system", optIn: true },
  ),
  ...locations(
    "Xcode",
    "retained",
    "System-owned documentation cache",
    {
      "xcode.system-documentation": "Library/Developer/Xcode/DocumentationCache",
    },
    { platform: "darwin", base: "system", optIn: true },
  ),
];
