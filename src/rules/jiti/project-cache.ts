export const jitiProjectCache = {
  id: "jiti.project-cache",
  dependency: "jiti",
  components: [".cache", "jiti"],
  displayName: "Jiti project transform cache",
  reason: "jiti-project-cache",
  detail: "Configured project declares Jiti and contains its local filesystem transform cache.",
} as const;
