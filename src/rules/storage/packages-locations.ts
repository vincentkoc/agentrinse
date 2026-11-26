import { locations } from "./location.js";

export const packagesLocations = [
  ...locations(
    "Cargo",
    "direct",
    "Registry metadata includes source and indexes as well as cached archives",
    {
      "cargo.registry-root": ".cargo/registry",
    },
  ),
  ...locations("Cargo", "retained", "Git dependency checkouts and source history", {
    "cargo.git": ".cargo/git",
  }),
  ...locations("Maven", "direct", "Local repository can contain unpublished artifacts", {
    "maven.repository": ".m2/repository",
  }),
  ...locations("Bun", "direct", "User cache for Bun", {
    "bun.cache": ".cache/bun",
  }),
  ...locations("Gradle", "retained", "Installed project wrapper distributions", {
    "gradle.wrapper": ".gradle/wrapper/dists",
  }),
  ...locations("uv", "direct", "Alternative uv cache locations", {
    "uv.share-cache": ".local/share/uv/cache",
  }),
  ...locations(
    "uv",
    "direct",
    "Alternative uv cache locations",
    {
      "uv.cache-mac": "Library/Caches/uv",
    },
    { platform: "darwin" },
  ),
  ...locations("pip", "direct", "Python package and wheel cache", {
    "pip.cache": ".cache/pip",
  }),
  ...locations(
    "pip",
    "direct",
    "Python package and wheel cache",
    {
      "pip.cache-mac": "Library/Caches/pip",
    },
    { platform: "darwin" },
  ),
  ...locations("Deno", "direct", "Dependency and compiler cache", {
    "deno.cache": ".cache/deno",
  }),
  ...locations(
    "Deno",
    "direct",
    "Dependency and compiler cache",
    {
      "deno.cache-mac": "Library/Caches/deno",
    },
    { platform: "darwin" },
  ),
  ...locations("npm", "retained", "Diagnostic logs may contain private project details", {
    "npm.logs": ".npm/_logs",
  }),
  ...locations("Cabal", "retained", "Installed Haskell packages", {
    "cabal.store": ".cabal/store",
  }),
  ...locations("Stack", "retained", "Installed Haskell compiler toolchains", {
    "stack.programs": ".stack/programs",
  }),
  ...locations("Coursier", "direct", "JVM package cache", {
    "coursier.cache": ".cache/coursier",
  }),
  ...locations(
    "Coursier",
    "direct",
    "JVM package cache",
    {
      "coursier.macos": "Library/Caches/Coursier",
    },
    { platform: "darwin" },
  ),
  ...locations("Yarn", "direct", "Package archive cache", {
    "yarn.xdg": ".cache/yarn",
    "yarn.berry": ".yarn/berry/cache",
    "yarn.cache": ".yarn/cache",
  }),
  ...locations(
    "Yarn",
    "direct",
    "Package archive cache",
    {
      "yarn.macos": "Library/Caches/Yarn",
    },
    { platform: "darwin" },
  ),
  ...locations("Ivy", "direct", "JVM dependency cache", {
    "ivy.cache": ".ivy2/cache",
  }),
  ...locations(
    "pnpm",
    "direct",
    "Alternative package store on macOS",
    {
      "pnpm.store-xdg-mac": ".local/share/pnpm/store",
    },
    { platform: "darwin" },
  ),
  ...locations("pnpm", "retained", "Legacy store may support active projects", {
    "pnpm.legacy-store": ".pnpm-store",
  }),
  ...locations("sbt", "retained", "Installed JVM build-tool bootstrap files", {
    "sbt.boot": ".sbt/boot",
  }),
  ...locations("Ruby", "direct", "Ruby package, specification and build caches", {
    "bundler.cache": ".bundle/cache",
    "rubygems.specs": ".gem/specs",
    "rbenv.cache": ".rbenv/cache",
  }),
  ...locations("pytest", "direct", "User-level pytest cache metadata", {
    "pytest.user-cache": ".pytest_cache",
  }),
  ...locations("Conda", "direct", "Cached packages can be shared with installed environments", {
    "conda.packages": ".conda/pkgs",
  }),
  ...locations("Poetry", "direct", "Python build and package cache", {
    "poetry.xdg": ".cache/poetry",
  }),
  ...locations(
    "Poetry",
    "direct",
    "Python build and package cache",
    {
      "poetry.artifacts": "Library/Caches/pypoetry/artifacts",
      "poetry.cache": "Library/Caches/pypoetry/cache",
    },
    { platform: "darwin" },
  ),
  ...locations("Ruff", "direct", "Ruff user cache metadata", {
    "ruff.user-cache": ".cache/ruff",
  }),
  ...locations("mypy", "direct", "mypy user cache metadata", {
    "mypy.user-cache": ".cache/mypy",
  }),
  ...locations("tnpm", "direct", "Package content cache", {
    "tnpm.content": ".tnpm/_cacache",
  }),
];
