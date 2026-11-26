import { locations } from "./location.js";

export const mobileLocations = [
  ...locations(
    "Android SDK",
    "retained",
    "Installed Android SDK components and emulator state",
    {
      "android.system-images": "Library/Android/sdk/system-images",
      "android.emulator": "Library/Android/sdk/emulator",
      "android.build-tools": "Library/Android/sdk/build-tools",
      "android.platforms": "Library/Android/sdk/platforms",
      "android.ndk": "Library/Android/sdk/ndk",
    },
    { platform: "darwin" },
  ),
  ...locations("Android SDK", "retained", "Installed Android SDK components and emulator state", {
    "android.avds": ".android/avd",
  }),
  ...locations(
    "Xcode",
    "direct",
    "Xcode build and application cache metadata",
    {
      "xcode.build-cache": "Library/Caches/com.apple.dt.xcodebuild",
      "xcode.app-cache": "Library/Caches/com.apple.dt.Xcode",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Xcode",
    "retained",
    "Downloaded platforms and installable components are retained by Xcode",
    {
      "xcode.downloadable-platforms": "Library/Caches/com.apple.dt.Xcode.DownloadablePlatforms",
      "xcode.downloads": "Library/Caches/com.apple.dt.Xcode/Downloads",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Apple",
    "retained",
    "Diagnostic reports may contain private application state",
    {
      "apple.diagnostic-reports": "Library/Logs/DiagnosticReports",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "CoreSimulator",
    "retained",
    "Simulator caches and images managed by CoreSimulator",
    {
      "simulator.user-caches": "Library/Developer/CoreSimulator/Caches",
      "simulator.user-images": "Library/Developer/CoreSimulator/Images",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Xcode",
    "retained",
    "Installed toolchains, signed archives and device support symbols",
    {
      "xcode.toolchains": "Library/Developer/Toolchains",
      "xcode.archives": "Library/Developer/Xcode/Archives",
      "xcode.device-support": "Library/Developer/Xcode/iOS DeviceSupport",
    },
    { platform: "darwin" },
  ),
  ...locations("CocoaPods", "retained", "Local specification repositories", {
    "cocoapods.repos": ".cocoapods/repos",
  }),
  ...locations(
    "CocoaPods",
    "direct",
    "Pod download caches",
    {
      "cocoapods.cache": "Library/Caches/CocoaPods",
    },
    { platform: "darwin" },
  ),
  ...locations("SwiftPM", "retained", "Cache alias may refer to a shared target", {
    "swiftpm.cache-alias": ".swiftpm/cache",
  }),
];
