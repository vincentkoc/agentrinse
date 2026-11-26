// Native evidence is described here so listing rules never wakes a service or inspects a guest.
export const ownerEvidence = [
  {
    id: "git.registration",
    owner: "Git and worktree allocator",
    inventory: "worktrees --root <container> --repo <owner> --project-roots",
    requires:
      "Correlate linked, standalone, missing and conflicting registrations. Supply uncommon or temporary containers explicitly. An allocator must verify release, HEAD, pins, holders and recovery.",
  },
  {
    id: "git.maintenance",
    owner: "Git",
    inventory: "storage --family git --repo <owner>",
    requires:
      "Pack metadata covers stable packs, temporary packs and sidecars. The owner checks count-objects garbage, in-flight writers, promisor objects, keep markers, refs and maintenance headroom.",
  },
  {
    id: "crabbox.staging",
    owner: "Crabbox",
    inventory: "storage --family crabbox --crabbox-root <staging> --measure",
    requires:
      "Receipt-backed staging reports mirror age and allocated bytes. The native staging inspector owns pagination, mirror reuse, leases and retirement decisions.",
  },
  {
    id: "codebase-memory.registration",
    owner: "Codebase Memory",
    inventory: "storage --rule codebase-memory.graphs",
    requires:
      "Direct file observations do not identify duplicate graphs. The graph owner's registry resolves canonical projects, protected graphs and duplicate candidates.",
  },
  {
    id: "agent.session-custody",
    owner: "Agent or terminal",
    inventory: "storage --at runtime.recovery=<path>",
    requires:
      "Agent sessions, archived transcripts, recovery data and tmux history stay with their owner. Current session and holder evidence is required separately.",
  },
  {
    id: "project.outputs",
    owner: "Build tool",
    inventory: "audit --config <config>",
    requires:
      "Configured artifacts cover node_modules, dist, dist-runtime, build, target, .next, .turbo, coverage and virtual environments. Git, process and protection gates apply.",
  },
  {
    id: "project.transforms",
    owner: "Vite and Jiti",
    inventory: "audit --config <config>",
    requires:
      "Inspect declared dependencies and physical project caches. The producer and donor determine ownership of customized locations and the experimental Vitest cache.",
  },
  {
    id: "project.copies",
    owner: "Git or producing service",
    inventory: "storage --at project.checkout-copy=<path>",
    requires:
      "Synthetic carriers, qualification clones, old service homes, backups and proof can be the only copy of source or recovery data.",
  },
  {
    id: "package.consumers",
    owner: "Package manager",
    inventory: "storage --at project.package-store=<path>",
    requires:
      "Use producer configuration for active toolchains, GOCACHE/GOMODCACHE/GOCACHEPROG, uv buckets, registry retention, pnpm generations, DLX, virtual stores, index registrations and shared donors.",
  },
  {
    id: "runtime.fixture-custody",
    owner: "Test or build producer",
    inventory: "storage --at runtime.temp=<path>",
    requires:
      "Inspect the exact per-user TMPDIR or system temporary child. Reconcile historical fixtures, independent Git objects and live holders with creation and teardown records.",
  },
  {
    id: "filesystem.mounts",
    owner: "Kernel",
    inventory: "storage --family mounts --volume <path>",
    requires:
      "Use the native mount table for APFS, Btrfs, AFP, SMB, autofs and tmpfs. An unmounted or remote volume cannot establish local reclaim.",
  },
  {
    id: "filesystem.apfs-snapshots",
    inventory: "storage --native-volume <mountpoint>",
    owner: "APFS volume owner",
    requires:
      "Use diskutil apfs list and listSnapshots for each mounted volume. Container free space, shared extents and nonpurgeable snapshots require native accounting.",
  },
  {
    id: "filesystem.btrfs-usage",
    inventory: "storage --native-volume <mountpoint>",
    owner: "Btrfs filesystem owner",
    requires:
      "On the mounted filesystem inspect btrfs filesystem usage, filesystem du, subvolumes and snapshots. Logical size, exclusive extents and allocator headroom differ.",
  },
  {
    id: "vm.guest-storage",
    owner: "Virtual machine owner",
    inventory: "storage --at runtime.virtual-disk=<path>",
    requires:
      "Host image allocation is separate from guest filesystem usage, Btrfs superblocks, Parallels snapshot registrations and WSL VHDX discovery. The guest owner inspects an already running guest.",
  },
  {
    id: "container.volumes",
    owner: "Docker, Colima or OrbStack",
    inventory: "storage --at runtime.container-data=<path>",
    requires:
      "Builder cache records, volume attachment, stopped workloads, image ancestry and guest backing storage require the active native backend.",
  },
  {
    id: "linux.retention",
    owner: "Linux administrator",
    requires:
      "Inspect journalctl --disk-usage, logrotate policy and APT archive ownership on the selected Linux host. Rotation, vacuum and autoremove are operator actions.",
  },
  {
    id: "linux.pressure",
    owner: "Linux administrator",
    requires:
      "Inspect mount and tmpfs capacity, open-deleted file holders, swap and memory pressure on the selected host.",
  },
  {
    id: "mobile.runtime-state",
    owner: "Xcode and mobile tool owners",
    requires:
      "Check installed runtimes, booted devices, archives, dSYMs, symbols, backups and available regeneration sources through their native owners.",
  },
  {
    id: "cloud.placeholders",
    owner: "Cloud storage provider",
    requires:
      "Placeholder, residency and sync ownership require the cloud provider. A local inventory must not hydrate files to infer reclaim.",
  },
  {
    id: "provider.maintenance",
    owner: "Provider or application",
    inventory: "adapters",
    requires:
      "Provider-owned maintenance, vacuum and compaction require an explicit supported producer action and current writer evidence. Credentials and application profiles stay opaque.",
  },
] as const;
