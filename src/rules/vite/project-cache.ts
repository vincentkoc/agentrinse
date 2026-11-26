export const viteProjectCaches = [
  {
    id: "vite.project-cache",
    dependency: "vite",
    components: [".vite"],
    displayName: "Vite project cache",
    reason: "vite-project-cache",
    detail: "Configured project declares Vite and contains its default cache directory.",
  },
  {
    id: "vite.bundled-config",
    dependency: "vite",
    components: [".vite-temp"],
    displayName: "Vite bundled configuration scratch",
    reason: "vite-bundled-config",
    detail: "Configured project declares Vite and contains its bundled configuration directory.",
  },
] as const;
