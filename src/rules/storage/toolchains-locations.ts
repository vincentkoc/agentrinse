import { locations } from "./location.js";

export const toolchainsLocations = [
  ...locations("Rustup", "retained", "Installed Rust toolchains and compiler components", {
    "rustup.toolchains": ".rustup/toolchains",
  }),
  ...locations("mise", "retained", "Installed runtimes and executable tools", {
    "mise.installs": ".local/share/mise/installs",
  }),
  ...locations("mise", "direct", "Tool metadata and downloads", {
    "mise.cache": ".cache/mise",
  }),
  ...locations(
    "mise",
    "direct",
    "Tool metadata and downloads",
    {
      "mise.cache-mac": "Library/Caches/mise",
    },
    { platform: "darwin" },
  ),
  ...locations("pre-commit", "retained", "Hook environments may be in use by active repositories", {
    "pre-commit.environments": ".cache/pre-commit",
  }),
  ...locations("Corepack", "retained", "Installed package managers required by project pins", {
    "corepack.managers": ".cache/node/corepack",
  }),
  ...locations("uv", "retained", "Installed Python interpreters and executable tools", {
    "uv.python": ".local/share/uv/python",
    "uv.tools": ".local/share/uv/tools",
  }),
  ...locations(
    "Homebrew",
    "direct",
    "Cached formula and cask API metadata",
    {
      "homebrew.api": "Library/Caches/Homebrew/api",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Homebrew",
    "retained",
    "Build and installation logs",
    {
      "homebrew.logs": "Library/Logs/Homebrew",
    },
    { platform: "darwin" },
  ),
  ...locations("ccache", "direct", "Compiler cache metadata", {
    "ccache.xdg": ".cache/ccache",
    "ccache.legacy": ".ccache",
  }),
  ...locations(
    "ccache",
    "direct",
    "Compiler cache metadata",
    {
      "ccache.macos": "Library/Caches/ccache",
    },
    { platform: "darwin" },
  ),
  ...locations("sccache", "direct", "Compiler cache metadata", {
    "sccache.xdg": ".cache/sccache",
  }),
  ...locations(
    "sccache",
    "direct",
    "Compiler cache metadata",
    {
      "sccache.macos": "Library/Caches/sccache",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "node-gyp",
    "direct",
    "Build headers and compiler cache",
    {
      "node-gyp.macos": "Library/Caches/node-gyp",
    },
    { platform: "darwin" },
  ),
  ...locations("node-gyp", "direct", "Build headers and compiler cache", {
    "node-gyp.xdg": ".cache/node-gyp",
    "node-gyp.legacy": ".node-gyp",
  }),
  ...locations("pyenv", "direct", "Downloaded Python build inputs", {
    "pyenv.cache": ".pyenv/cache",
  }),
  ...locations("Docker Buildx", "retained", "Builder-managed cache and state", {
    "buildx.user-cache": ".docker/buildx/cache",
  }),
  ...locations("TypeScript", "direct", "Compiler cache metadata", {
    "typescript.cache": ".cache/typescript",
  }),
  ...locations("Turborepo", "direct", "Task output cache metadata", {
    "turbo.user-cache": ".turbo/cache",
  }),
  ...locations("Vite", "direct", "User-level Vite cache candidates", {
    "vite.user-cache": ".vite/cache",
    "vite.xdg": ".cache/vite",
  }),
  ...locations("webpack", "direct", "Build cache metadata", {
    "webpack.cache": ".cache/webpack",
  }),
  ...locations("Parcel", "direct", "Build cache metadata", {
    "parcel.cache": ".parcel-cache",
  }),
  ...locations("ESLint", "direct", "Lint cache metadata", {
    "eslint.cache": ".cache/eslint",
  }),
  ...locations("Prettier", "direct", "Format cache metadata", {
    "prettier.cache": ".cache/prettier",
  }),
];
