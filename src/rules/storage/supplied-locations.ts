// The caller supplies the exact path. These rules inspect root metadata only.
export const suppliedLocations = [
  {
    id: "project.maintainer-reports",
    owner: "Project maintainer",
    reason: "Retained project maintenance reports",
  },
  {
    id: "npm.rescue",
    owner: "npm",
    reason: "Retained archives and locally produced packages",
  },
  {
    id: "pnpm.rescue",
    owner: "pnpm",
    reason: "Retained unindexed or local-only package objects",
  },
  {
    id: "project.proof",
    owner: "Project maintainer",
    reason: "Release and task proof retained by its owner",
  },
  {
    id: "corepack.project",
    owner: "Corepack",
    reason: "A project-specific package-manager installation",
  },
  {
    id: "project.qualification",
    owner: "Project maintainer",
    reason: "Qualification checkout and recovery state",
  },
  {
    id: "project.vendor",
    projectRelative: "vendor",
    owner: "Project",
    reason: "Vendored source can contain unpublished edits or offline dependencies.",
  },
  {
    id: "project.unverified-transform",
    projectRelative: "node_modules/.experimental-vitest-cache",
    owner: "Project",
    reason:
      "A directory named .experimental-vitest-cache needs producer and configuration evidence.",
  },
  {
    id: "project.backup",
    owner: "Project",
    reason:
      "Portable archives, rollback releases and prior service homes require restoration and retention evidence.",
  },
  {
    id: "project.checkout-copy",
    owner: "Git",
    reason:
      "Standalone clones, synthetic carriers and recovery trees may contain unpublished objects.",
  },
  {
    id: "runtime.temp",
    owner: "Runtime owner",
    reason:
      "An explicit prior fixture or temporary root can contain live state, sessions or independent Git checkouts.",
  },
  {
    id: "runtime.recovery",
    owner: "Terminal or agent owner",
    reason: "Session history, recovery databases, leases and tmux restore state are retained.",
  },
  {
    id: "runtime.virtual-disk",
    owner: "Virtual machine owner",
    reason:
      "Disk and snapshot custody, guest filesystem usage and host compaction require the VM owner.",
  },
  {
    id: "runtime.container-data",
    owner: "Container backend",
    reason: "Backing stores and named volumes may serve stopped workloads.",
  },
  {
    id: "project.package-store",
    owner: "Package manager",
    reason:
      "Effective override, donor and store locations require producer configuration and consumers.",
  },
  {
    id: "project.mobile-backup",
    owner: "Device owner",
    reason: "Mobile device backups and release archives may be irreplaceable.",
  },
] as const;
