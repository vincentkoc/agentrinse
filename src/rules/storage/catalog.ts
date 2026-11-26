import { join } from "node:path";

type Location = {
  id: string;
  owner: string;
  relative: string;
  scope: "direct" | "retained" | "image";
  reason: string;
  platform?: "darwin" | "linux";
};
// Literal paths only. A new location must name its producer and its inspection boundary.
export const storageLocations: readonly Location[] = [
  {
    id: "npm.content",
    owner: "npm",
    relative: ".npm/_cacache",
    scope: "direct",
    reason: "Content-addressable package cache",
  },
  {
    id: "npm.exec",
    owner: "npm",
    relative: ".npm/_npx",
    scope: "direct",
    reason: "Executions and installed dependency trees",
  },
  {
    id: "pnpm.store-mac",
    owner: "pnpm",
    relative: "Library/pnpm/store",
    platform: "darwin",
    scope: "direct",
    reason: "Package store with potentially shared installed files",
  },
  {
    id: "pnpm.store-linux",
    owner: "pnpm",
    relative: ".local/share/pnpm/store",
    platform: "linux",
    scope: "direct",
    reason: "Package store with potentially shared installed files",
  },
  {
    id: "pnpm.manager",
    owner: "pnpm",
    relative: "Library/pnpm/package-manager-store",
    platform: "darwin",
    scope: "direct",
    reason: "Retained package-manager installations",
  },
  {
    id: "pnpm.cache",
    owner: "pnpm",
    relative: ".cache/pnpm",
    scope: "direct",
    reason: "Package manager cache",
  },
  {
    id: "go.build-mac",
    owner: "Go",
    relative: "Library/Caches/go-build",
    platform: "darwin",
    scope: "direct",
    reason: "Compiler build cache",
  },
  {
    id: "go.build-linux",
    owner: "Go",
    relative: ".cache/go-build",
    platform: "linux",
    scope: "direct",
    reason: "Compiler build cache",
  },
  {
    id: "go.modules",
    owner: "Go",
    relative: "go/pkg/mod",
    scope: "direct",
    reason: "Downloaded modules may supply offline builds",
  },
  {
    id: "uv.cache",
    owner: "uv",
    relative: ".cache/uv",
    scope: "direct",
    reason: "Versioned package cache buckets",
  },
  {
    id: "homebrew.downloads",
    owner: "Homebrew",
    relative: "Library/Caches/Homebrew/downloads",
    platform: "darwin",
    scope: "direct",
    reason: "Cached downloads",
  },
  {
    id: "cargo.registry",
    owner: "Cargo",
    relative: ".cargo/registry/cache",
    scope: "direct",
    reason: "Crate archive cache, separate from credentials and Git checkouts",
  },
  {
    id: "gradle.caches",
    owner: "Gradle",
    relative: ".gradle/caches",
    scope: "direct",
    reason: "Versioned Gradle caches",
  },
  {
    id: "bun.install",
    owner: "Bun",
    relative: ".bun/install/cache",
    scope: "direct",
    reason: "Installed package cache",
  },
  {
    id: "codebase-memory.graphs",
    owner: "codebase-memory-mcp",
    relative: ".cache/codebase-memory-mcp",
    scope: "direct",
    reason: "Graph and runtime files, database contents remain opaque",
  },
  {
    id: "swiftpm.cache",
    owner: "SwiftPM",
    relative: "Library/Caches/org.swift.swiftpm",
    platform: "darwin",
    scope: "direct",
    reason: "Package Manager cache",
  },
  {
    id: "playwright.browsers-mac",
    owner: "Playwright",
    relative: "Library/Caches/ms-playwright",
    platform: "darwin",
    scope: "direct",
    reason: "Managed browser installations",
  },
  {
    id: "playwright.browsers-linux",
    owner: "Playwright",
    relative: ".cache/ms-playwright",
    platform: "linux",
    scope: "direct",
    reason: "Managed browser installations",
  },
  {
    id: "puppeteer.browsers",
    owner: "Puppeteer",
    relative: ".cache/puppeteer",
    scope: "direct",
    reason: "Managed browser installations",
  },
  {
    id: "xcode.derived",
    owner: "Xcode",
    relative: "Library/Developer/Xcode/DerivedData",
    platform: "darwin",
    scope: "direct",
    reason: "Build intermediates may serve live projects",
  },
  {
    id: "xcode.devices",
    owner: "CoreSimulator",
    relative: "Library/Developer/CoreSimulator/Devices",
    platform: "darwin",
    scope: "retained",
    reason: "Persistent simulator device state",
  },
  {
    id: "orbstack.disk",
    owner: "OrbStack",
    relative: "Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw",
    platform: "darwin",
    scope: "image",
    reason: "Host sparse VM image; guest filesystem and deletion effects require the guest owner",
  },
  {
    id: "orbstack.swap",
    owner: "OrbStack",
    relative: "Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/swap.img",
    platform: "darwin",
    scope: "image",
    reason: "Guest swap image on the host filesystem",
  },
  {
    id: "crabbox.controller",
    owner: "Crabbox",
    relative: "Library/Application Support/crabbox",
    platform: "darwin",
    scope: "retained",
    reason: "Controller state, separate from source staging",
  },
  {
    id: "codex.artifacts",
    owner: "Codex",
    relative: ".codex/artifacts",
    scope: "retained",
    reason: "Mixed deliverables and recovery state",
  },
  {
    id: "codex.review-artifacts",
    owner: "Codex",
    relative: ".codex/review-artifacts",
    scope: "retained",
    reason: "Mixed review and recovery material",
  },
  {
    id: "codex.tmp",
    owner: "Codex",
    relative: ".codex/tmp",
    scope: "retained",
    reason: "Temporary and live runtime state",
  },
  {
    id: "trash.macos",
    owner: "Trash",
    relative: ".Trash",
    platform: "darwin",
    scope: "retained",
    reason: "User recovery and restoration metadata",
  },
  {
    id: "trash.linux",
    owner: "Trash",
    relative: ".local/share/Trash",
    platform: "linux",
    scope: "retained",
    reason: "User recovery and restoration metadata",
  },
];

export function localStorageLocations(home: string, platform: NodeJS.Platform) {
  return storageLocations
    .filter((l) => !l.platform || l.platform === platform)
    .map((l) => ({ ...l, path: join(home, l.relative) }));
}
