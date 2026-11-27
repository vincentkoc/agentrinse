# Storage inventory

Run `agentrinse storage-rules` to find the stable ID and inspection method for a location. Run `agentrinse storage --json --redact` to inventory the default locations on this host. Both commands are read-only. The inventory reports what the process could observe, including missing paths, withheld mounts and incomplete measurements.

A `direct` observation counts immediate regular files and directories. A `retained` observation checks only the root. Image observations report logical size and allocated blocks. Byte counts are decimal strings. Use `--measure` on a catalog entry with `treeMeasurement: true` for a bounded traversal of its eligible descendants. An overridden package store can live elsewhere. Use its producer to resolve the effective path.

| Owner                         | Source and scope                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm and pnpm                  | [npm cache](https://docs.npmjs.com/cli/v11/commands/npm-cache/) and [pnpm store](https://pnpm.io/settings#storedir). Installed versions, execution trees and content stores have different owners and may share files.                                                                                                                     |
| Go, uv, Cargo, Gradle, Bun    | [Go caching](https://go.dev/cmd/go/#hdr-Build_and_test_caching), [uv storage](https://docs.astral.sh/uv/reference/storage/), [Cargo home](https://doc.rust-lang.org/cargo/guide/cargo-home.html), [Gradle directories](https://docs.gradle.org/current/userguide/directory_layout.html), [Bun cache](https://bun.sh/docs/pm/global-cache). |
| Homebrew, SwiftPM, Xcode      | [Homebrew cache](https://docs.brew.sh/Manpage#environment), [Swift Package Manager](https://www.swift.org/documentation/package-manager/). DerivedData is distinct from persistent simulator devices.                                                                                                                                      |
| Playwright and Puppeteer      | [Playwright browser management](https://playwright.dev/docs/browsers) and [Puppeteer configuration](https://pptr.dev/guides/configuration). These browsers may support many projects.                                                                                                                                                      |
| Codebase Memory, Codex, Trash | [Codebase Memory configuration](https://github.com/DeusData/codebase-memory-mcp/blob/main/docs/CONFIGURATION.md). Graph databases stay closed. Mixed agent and recovery roots are retained without enumerating their contents.                                                                                                             |
| OrbStack                      | [OrbStack storage](https://docs.orbstack.dev/architecture). The host image and swap file have a logical size and allocated blocks. Guest filesystem type and free space require a separate guest observation.                                                                                                                              |

## Select locations

| To inspect                                                          | Command                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Rules, including the evidence a native owner must supply            | `agentrinse storage-rules --json`                                     |
| One known cache and its eligible descendants                        | `agentrinse storage --rule npm.content --measure --max-entries 50000` |
| Immediate Codex database and sidecar files by metadata              | `agentrinse storage --rule codex.database-files`                      |
| System-owned Apple locations by root metadata                       | `agentrinse storage --system`                                         |
| A package rescue archive at its actual path                         | `agentrinse storage --at npm.rescue=/work/rescue`                     |
| Vendored source and an experimental transform cache under a project | `agentrinse storage --project /work/project`                          |

Repeat `--rule`, `--at` or `--project` for additional locations. Combine them with `--system` to include system locations. These selectors restrict the location list. `--family` further limits the owners shown. For an unclassified retained root, use `--retained-root /absolute/path`.

Credential caches require explicit selection and expose root metadata only. The Codex database rule counts immediate matching regular files once per inode and leaves databases closed. Project inspection preserves vendor trees and experimental transform directories even when they are large.

## Mounted filesystems

`agentrinse storage --family mounts --volume /absolute/path` identifies the covering filesystem using the kernel mount table. AFP, SMB, NFS and automount paths stay opaque. To collect counters from an **already mounted local filesystem**, specify its exact mountpoint.

```sh
# macOS, APFS startup volume
agentrinse storage --native-volume /

# Linux, when /mnt/data is a Btrfs mountpoint
agentrinse storage --native-volume /mnt/data
```

APFS reports snapshot counts, purgeability and container capacity. Btrfs reports device, allocated and unallocated bytes. A changed mount or failed probe yields `unavailable`. Missing APFS capacity or purgeability yields `partial` and preserves the known counts. Native counters describe the selected filesystem. Inspect an OrbStack guest from inside the running guest to obtain its counters. Sparse images, shared extents and snapshots prevent a physical reclaim estimate.

## Git pack storage

Pass one or more durable repository roots explicitly. For example, `agentrinse storage --family git --repo /work/projects/one --repo /work/projects/two --json`. Bare common directories also work. A linked checkout reports that it needs its durable owner. The inventory reads metadata for direct regular files in the owner's `objects/pack` directory. It does not read objects, follow alternates, or run Git maintenance.

The report separates ordinary packs, indexes, sidecars, `tmp_pack_*` names, `tmp_idx_*` names and other names starting with `tmp`. Names alone do not establish that an operation ended or a file is disposable. Per-repository figures count observed names. Global figures count each device/inode once, including hardlinked files across owners. Conflicting names with stable metadata use an ambiguous group. Files whose metadata or allocation changed between sightings are omitted from the global stable byte totals. Allocated bytes can include shared extents. [Git repository layout](https://git-scm.com/docs/gitrepository-layout)

Use `agentrinse worktrees --repo /work/projects/one --project-roots` to correlate registrations with the owner's `.worktrees` and `.claude/worktrees` containers. Add `--root` for each additional container, such as a managed worktree root or a temporary test directory. A missing registration, standalone checkout or stale-looking directory still requires its owner's decision.

## OpenClaw Crabbox staging

`agentrinse storage --family crabbox` checks `~/.cache/openclaw/crabbox-sync`. Supply `--crabbox-root /absolute/staging/root` to replace the default. The controller directory is retained separately. The inventory counts the direct mirror index, then checks at most 256 owner-matching v2 `staging.json` receipts bounded to 32 KiB apiece. It does not inspect source payloads, controller databases, mirror slots or active jobs.

A matched receipt reports its state, users and mirror timing. A durable mirror with a manifest can report an idle prepared or preserved state. A usable timestamp, matching user state and absence of a hold, disposal or recovery lock are required for the separate reusable-mirror receipt classification. This is preliminary receipt evidence. Unknown, missing, legacy and malformed receipts provide no cleanup authorization. Use the producer's staging inspection for live ownership and release decisions. [OpenClaw staging producer](https://github.com/openclaw/openclaw/blob/6136262f59d0c3803aca0c911df2511ec97846fa/scripts/crabbox-staging.mts)

A receipt can retain lease IDs after settlement. The report includes their count and leaves live holders unverified. The 48-hour review window uses the validated mirror last-use timestamp in milliseconds. Future or absent timestamps cannot establish the window. The current staging root and its literal payload must match their receipt identities on the same local mount. When present, stable identity fields bind the physical path, birth time and volume. A changed device number is accepted when the inode, canonical path, birth time and native volume UUID still match for both directories. Receipts with only a device number require the original device. The receipt and both directories are checked again after measurement. A replacement or relocation invalidates the observed bytes. File modification times never establish mirror eligibility.

## Measure nested cache trees

Use `agentrinse storage --family developer --rule npm.content --measure --max-entries 50000` to count nested regular files in an eligible cache. Repeat `--rule` to select additional catalog locations. Developer cache measurement is opt-in at both the CLI and catalog-rule level. Provider data, graph databases, simulator state, installed package-manager binaries, recovery roots and VM images retain their dedicated inspection boundaries.

For Crabbox, request `--family crabbox --measure` or supply `--crabbox-root /path/to/staging --measure`. The inventory visits ordinary files and directories by metadata inside receipt-verified capsules. It reads only the fixed receipt contents. Protected agent and VCS directories, credential roots, symlinks, special entries and nested mounts are excluded. A failed identity check leaves the capsule unmeasured. Per-root results label complete, lower-bound and unknown measurements. File hardlinks count once within each measured tree. Do not add these numbers across overlapping selections or treat allocated bytes as physical reclaim.

## OpenClaw review lanes

Run `agentrinse storage --family openclaw --measure --json --redact` to inspect both `~/.cache/openclaw/crabbox-sync` and `~/.cache/openclaw/pr-dependencies`. Plain `storage` discovers both. To select just one, use `--rule crabbox.staging` or `--rule openclaw.pr-dependencies`.

The PR dependency report covers direct legacy entries and the installations, installation stages and retirement stages under `v3`. Unknown directories receive a shallow observation. The lifetime database, leases and metadata lock stay closed. Size measurement is optional and bounded by `--max-entries`; excluded links, protected directories, mounts and budget limits can make totals incomplete.

`directoryMtimeReview: older-than-48-hours` means the directory's own modification time is over two days old. A running lane can reuse a donor through a symlink without changing that time. For Crabbox, compare the separate receipt-backed `lastUseReview` when present. Before pruning, use the producing tool to verify lane references, leases, locks and live holders. Preserve unresolved entries. The inventory creates no cleanup actions.

## Add a storage location

The [package-store rules](../src/rules/storage/package-stores.ts) include `npm.content` as a worked example. Give a new literal location its own stable ID, owner, home-relative path, scope and public source. Set `measureTree` only for a known cache leaf that supports metadata-only traversal. Add a temporary-fixture test for the location, symlink and native mount boundaries. Keep receipt parsing in its producer's rule module.

## OpenClaw PR review checkouts

For a primary OpenClaw checkout, `worktrees --repo "$OWNER" --project-roots`
identifies direct `.worktrees/pr-N` directories and native registrations. The
rule recognizes the official GitHub HTTPS and SSH origin spellings used by
OpenClaw’s own PR tool. Other repositories retain generic worktree inventory.

Import an existing native preview without rerunning it:

```sh
agentrinse worktrees --repo "$OWNER" --project-roots --openclaw-pr-gc-stdin --measure --redact --json < gc-dry.txt
```

For a fresh preview, use this grouping in a trusted OpenClaw checkout. The first
and last lines record the physical owner and success of the native command:

```sh
(
  cd "$OWNER" &&
  printf 'agentrinse-openclaw-pr-gc-v1 %s\n' "$(pwd -P)" &&
  scripts/pr gc --dry-run &&
  printf '%s\n' agentrinse-openclaw-pr-gc-complete
) | agentrinse worktrees --repo "$OWNER" --project-roots --openclaw-pr-gc-stdin --measure --json
```

AgentRinse reads the supplied preview. It never runs the project script. The
native preview itself can query GitHub and temporarily acquire and release PR
operation refs. To preview a single PR, add `--pr 123` to the native command.
Use a canonical absolute primary checkout for `OWNER`.

`openClawPrWorktrees` reports the native claim and a separate local review grade
for each PR. Plain stdout supplies reported counts and corroboration, including
structured skip diagnostics. It has no owner or completion marker. A missing
row supplies no PR state. Native GC can omit open or indeterminate PRs. Failed
templates use a different owner contract and stay unknown. Input is bounded to
4 MiB and 20,000 lines; mixed mutation output, malformed rows and conflicts
withhold all positive review grades.

A positive owner-review grade requires a completed owner-bound preview, a
reciprocal checkout, matching native registration and current lock evidence.
For up to 512 corroborated unlocked candidates, a bounded Git names-only check
includes both ignored and ordinary untracked material. An ignored patch or
local proof script can survive a clean Git status while being lost on removal.
Any observed material, timeout, output limit or changed evidence withholds the
grade. Per-row sizes count observed logical file bytes under `--measure`;
partial and unavailable rows remain explicit. Reclaimable bytes stay unknown.

The preview and grade are evidence for an owner’s review. Recheck current
tracked changes, holders, recovery, branch ancestry and source preservation
with the native owner before any separately authorized cleanup. Real PR GC can
also remove PR-only local branches after removing a registered checkout.
After a real GC run, verify checkout absence, registration removal and branch
outcomes separately. Branch retirement can fail after the checkout and its
registration are already gone. Supply only dry-run output to the importer.
