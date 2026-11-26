import { locations } from "./location.js";

export const desktopLocations = [
  ...locations(
    "Chrome",
    "direct",
    "Browser and GPU cache locations, excluding user profiles",
    {
      "chrome.cache": "Library/Caches/Google/Chrome",
      "chrome.shader-cache": "Library/Application Support/Google/Chrome/GrShaderCache",
    },
    { platform: "darwin" },
  ),
  ...locations("Hugging Face", "retained", "Model downloads can be pinned or required offline", {
    "huggingface.models": ".cache/huggingface/hub",
  }),
  ...locations(
    "Claude Desktop",
    "direct",
    "Application cache metadata",
    {
      "claude.desktop-cache": "Library/Caches/com.anthropic.claudefordesktop",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Mozilla",
    "direct",
    "Browser cache location separate from user profiles",
    {
      "mozilla.cache": "Library/Caches/Mozilla",
    },
    { platform: "darwin" },
  ),
  ...locations("Ollama", "retained", "Installed models and manifests", {
    "ollama.models": ".ollama/models",
  }),
  ...locations(
    "Ollama",
    "direct",
    "Application cache metadata",
    {
      "ollama.cache": "Library/Caches/ollama",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "VS Code",
    "direct",
    "Editor caches and extension archives",
    {
      "vscode.cache": "Library/Application Support/Code/Cache",
      "vscode.cached-data": "Library/Application Support/Code/CachedData",
      "vscode.code-cache": "Library/Application Support/Code/Code Cache",
      "vscode.extension-archives": "Library/Application Support/Code/CachedExtensionVSIXs",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Playwright",
    "direct",
    "Alternative browser cache on macOS",
    {
      "playwright.browsers-xdg-mac": ".cache/ms-playwright",
    },
    { platform: "darwin" },
  ),
  ...locations("Selenium", "retained", "Browser and driver installations", {
    "selenium.drivers": ".cache/selenium",
  }),
  ...locations("PyTorch", "retained", "Model and repository downloads", {
    "torch.hub": ".cache/torch/hub",
  }),
  ...locations("Trash", "retained", "User-managed recovery payloads", {
    "trash.xdg-files": ".local/share/Trash/files",
  }),
  ...locations(
    "Cursor",
    "direct",
    "Editor caches and extension archives",
    {
      "cursor.cached-data": "Library/Application Support/Cursor/CachedData",
      "cursor.extension-archives": "Library/Application Support/Cursor/CachedExtensionVSIXs",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "Cypress",
    "retained",
    "Installed browser testing binaries",
    {
      "cypress.binaries": "Library/Caches/Cypress",
    },
    { platform: "darwin" },
  ),
  ...locations(
    "JetBrains",
    "retained",
    "IDE, Toolbox and remote development installation state",
    {
      "jetbrains.caches": "Library/Caches/JetBrains",
      "jetbrains.toolbox": "Library/Caches/JetBrains/Toolbox",
      "jetbrains.remote-dev": "Library/Caches/JetBrains/RemoteDev",
    },
    { platform: "darwin" },
  ),
  ...locations("Electron", "direct", "Electron download cache", {
    "electron.xdg": ".cache/electron",
  }),
  ...locations(
    "Electron",
    "direct",
    "Electron download cache",
    {
      "electron.macos": "Library/Caches/electron",
    },
    { platform: "darwin" },
  ),
];
