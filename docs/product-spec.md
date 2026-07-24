# AgentRinse Product and Engineering Specification

Status: active implementation

Target version: 0.3.0

Created: 2026-07-23

Updated: 2026-07-24

Owner: Vincent Koc

Canonical domain: `https://agentrinse.com`

Target repository: `https://github.com/vincentkoc/agentrinse`

Target npm package and binary: `agentrinse`

License: MIT

## Executive Decision

Build AgentRinse as a local-first cleanup and diagnostics CLI for developers
using coding agents.

AgentRinse will find, explain, plan, clean, quarantine, and recover stale
resources created by agentic development workflows. Its first-class domains
are:

- Git worktrees and their rebuildable artifacts
- Codex, Claude, Cursor, GitHub Copilot, Zed, OpenCode, and Grok Build
  session-linked state
- agent logs and diagnostic databases
- stale agent runtime installations
- Docker images, stopped containers, networks, and build cache
- optional handoff to general-purpose cleaners such as Mole

AgentRinse is not a generic Mac cleaner and must not compete with Mole,
CleanMyMac, or operating-system maintenance tools. Its defensible product
boundary is the context generic cleaners do not have: agent sessions, Git
reachability, worktree ownership, live process state, provider retention
contracts, and recoverable developer intent.

The core abstraction is garbage collection:

1. Discover resources.
2. Discover roots that prove resources are still reachable.
3. Classify unreachable resources using explicit policy.
4. Produce a deterministic, reviewable plan.
5. Revalidate the plan immediately before mutation.
6. Apply only actions authorized by the selected risk ceiling.
7. Preserve recovery metadata and an audit trail.

The product promise is:

> rinse the debris, keep the work

The safety promise is stronger:

> no live session, dirty worktree, unpushed commit, pinned resource, locked
> resource, credential store, Docker volume, or unknown state is deleted by
> default.

## Product Thesis

Agentic development creates a new class of local infrastructure debt:

- one task creates several worktrees
- each worktree restores dependencies and build caches
- agent transcripts and diagnostic logs accumulate continuously
- background tools keep references that a filesystem scan cannot see
- Docker builds leave images and cache records behind
- a worktree that looks old may still be the resume target for a live thread
- provider applications already perform partial cleanup using their own rules
- generic cleanup tools understand disk usage but not developer intent

This is not fundamentally a "find large folders" problem. It is a reachability
and lifecycle problem.

AgentRinse should become the cleanup control plane for local agent development:
one command explains what exists, why it is protected, what can be reclaimed,
and what recovery path remains after cleanup.

## Why AgentRinse

The name is short, legible, package-friendly, and directly communicates the
product:

- "Agent" defines the domain.
- "Rinse" implies clearing residue after useful work.
- It does not promise destructive deep cleaning.
- It supports a useful vocabulary: audit, rinse plan, rinse run, rinse history,
  rinse-safe, and needs-rinse.

Brand guidance:

- Product name: `AgentRinse`
- CLI/package name: `agentrinse`
- Domain: `agentrinse.com`
- Suggested description: "Safe cleanup for agentic development."
- Suggested longer description: "Audit and reclaim stale agent worktrees,
  logs, caches, and containers without deleting live or unpushed work."
- Avoid sanitation gimmicks, medical imagery, mascots, or a jokey destructive
  tone. The product handles valuable local state and should feel precise.

## Research Snapshot

This section records the evidence used to shape the specification. It is
non-normative and should be refreshed before implementation begins.

Research date: 2026-07-23. Release-state refresh: 2026-07-24.

### Name availability snapshot

At the initial research snapshot:

- the public npm registry returned `E404` for `agentrinse`
- Verisign RDAP returned HTTP `404` for `agentrinse.com`

The 2026-07-24 release-state refresh found the name still unclaimed on npm,
the domain still unregistered, and the public GitHub repository available at
the target URL. Registry and domain availability are signals, not ownership
guarantees. Reserve both before announcing the supported `0.1.0` release.

### Local motivating evidence

A read-only audit of the owner's current development environment found:

- approximately 29 GiB under `$CODEX_HOME/sessions`
- approximately 31 GiB under `$CODEX_HOME/worktrees`
- approximately 126 MiB under `$HOME/.claude/projects`
- a Codex logs database approximately 2.6 GiB in size
- a Codex logs WAL approximately 496 MiB in size
- approximately 2.4 GiB represented by free pages in that logs database
- Docker configured through an OrbStack context, with the daemon unavailable
  during the audit

These numbers are not product defaults and must never appear as user-specific
fixtures in a public repository. They demonstrate three separate opportunities:

1. worktree artifact cleanup can recover tens of gigabytes
2. diagnostic databases need provider-aware inspection
3. unavailable dependencies must produce useful findings rather than aborting
   the whole audit

### Existing local cleanup behavior

The current personal toolchain provides useful source material:

- `gwt audit`, `gwt ls`, and `gwt clean` establish the worktree workflow.
- `agent-worktree-clean` protects dirty and busy worktrees and trims
  rebuildable artifacts.
- `doctor --vacuum-codex` checks for active Codex processes before running an
  SQLite vacuum.
- `deepclean` is dry-run by default, runs worktree maintenance, then hands
  general cleanup to Mole.
- the cleanup tools intentionally do not kill Codex, Claude, tmux, terminal,
  SSH, mosh, Crabbox, Blacksmith, or Testbox processes.

AgentRinse should preserve those instincts while fixing the current gaps:

- current-session roots are incomplete
- Claude state is not part of the same reachability graph
- stash and unpushed-commit analysis is incomplete
- quarantine does not provide a durable undo period
- plans are not persisted or content-addressed
- there is no stable machine-readable contract
- Docker and provider diagnostics are separate ad hoc operations

### Upstream contracts

Current upstream behavior affects the product boundary:

- Codex keeps a configurable number of recent Codex-managed worktrees and
  protects pinned, in-progress, and permanent worktrees from automatic
  deletion.
- Codex thread JSONL files are durable replay data; SQLite is not a complete
  substitute for them.
- Codex archives a thread by moving its canonical rollout file and updating
  metadata.
- Codex log storage uses SQLite WAL behavior and performs retention/checkpoint
  work, but database compaction is a separate concern.
- Claude Code's `cleanupPeriodDays` controls deletion of old session data and
  orphaned worktrees, with a default of 30 days at the time of research.
- Cursor stores workspace-linked chat state in editor workspace storage, so
  deleting a workspace database can make agent history inaccessible.
- GitHub Copilot CLI keeps configuration, local sessions, logs, and
  customizations under its configurable Copilot directory.
- Zed exposes a configurable user-data directory containing its database,
  extensions, and logs.
- OpenCode stores session data and snapshots under its data directory; its
  snapshot Git repositories can become a major disk consumer and also carry
  user-visible undo state.
- Grok Build uses `GROK_HOME`, defaulting to `$HOME/.grok`, and is sufficiently
  new that its local storage contract must be version-gated from source.
- Git exposes a stable `git worktree list --porcelain -z` format and explicit
  lock, remove, prune, and repair semantics.
- Docker prune commands support age and label filters, but volumes are durable
  user data and require a much higher safety bar.
- Mole already owns broad macOS cleanup and project artifact scanning under
  GPL-3.0.

Consequences:

- AgentRinse must not raw-delete Codex or Claude transcripts in its first
  releases.
- AgentRinse must not raw-delete Cursor, Copilot, Zed, OpenCode, or Grok Build
  sessions in its first releases.
- AgentRinse must cooperate with provider-native lifecycle behavior.
- AgentRinse must treat a session-linked worktree as reachable even if its
  filesystem timestamps appear old.
- AgentRinse must treat Git locks and provider pins as hard roots.
- AgentRinse should invoke Mole only as an external optional tool. GPL code
  must not be copied, linked, or vendored into the MIT package.

## Goals

### Product goals

1. Give one accurate view of disk consumed by agent development workflows.
2. Explain why every discovered resource is protected, eligible, skipped, or
   unknown.
3. Reclaim rebuildable and unreachable resources without destroying work.
4. Make cleanup usable by both humans and agents through stable output.
5. Make every mutating run reproducible, reviewable, and attributable.
6. Provide a real recovery path for whole-worktree cleanup.
7. Degrade gracefully when an adapter, daemon, provider, or permission is
   unavailable.
8. Compose with provider-native cleanup and general-purpose cleaners.
9. Remain useful without a daemon, cloud account, telemetry service, or GUI.
10. Publish as a small personal npm package with strong supply-chain hygiene.

### Strategic goals

1. Establish a reusable lifecycle model for additional agent tools.
2. Turn personal shell cleanup knowledge into tested, portable policy.
3. Become the cleanup companion for high-concurrency local agent workflows.
4. Create a durable machine-readable surface that skills and automation can
   use without scraping terminal prose.
5. Keep future options open for a desktop UI without coupling the core to one.

### Success criteria

AgentRinse succeeds when:

- an audit finds meaningful reclaimable space within seconds
- a user can tell why a worktree is protected without reading source code
- repeated audits with unchanged inputs produce equivalent findings
- stale worktrees with active ownership are never proposed for deletion
- dirty, untracked, ignored, status-suppressed, stashed, detached, or unpushed
  work is protected
- an interrupted run can be inspected and safely resumed or rolled back
- Docker being stopped does not prevent Git and provider audits
- `--json` remains stable enough for skills and scripts
- the product records zero known false-positive destructive cleanups

## Non-Goals

AgentRinse 1.0 will not:

- be a general-purpose Mac, Linux, or Windows cleaner
- remove arbitrary files based only on age or size
- kill processes to make resources removable
- delete Git branches
- rewrite Git history
- delete stashes
- delete Docker volumes by default
- delete credentials, auth profiles, configuration, memories, skills, prompts,
  or instruction files
- parse or modify transcript contents
- upload transcripts, filenames, commands, or disk inventories
- replace Codex or Claude session management
- replace Git's worktree administration
- replace Docker's resource ownership model
- embed Mole or reuse Mole implementation code
- provide a background daemon in the MVP
- silently schedule recurring deletion
- promise byte-perfect recovery for directly deleted rebuildable caches
- support third-party executable plugins in the MVP
- optimize databases while their owning application may be running

## Users and Jobs

### Primary user: high-concurrency agent developer

Characteristics:

- runs Codex, Claude, or both
- uses many Git worktrees
- keeps multiple terminal and tmux sessions alive
- works across several repositories
- accumulates dependencies, build output, transcripts, logs, and containers

Jobs:

- "show me what agent work is consuming disk"
- "remove finished worktrees without losing anything"
- "trim heavy artifacts while keeping a resumable worktree"
- "tell me which active session is protecting this path"
- "clean old Docker build residue without touching data volumes"
- "compact diagnostic storage only when it is safe"

### Secondary user: coding agent

The agent needs:

- deterministic non-interactive commands
- stable JSON and exit codes
- explicit risk ceilings
- no confirmation prompt when a plan has already been authorized
- precise blockers instead of ambiguous prose
- the ability to prove that it did not cross ownership boundaries

### Secondary user: maintainer or tool author

The maintainer needs:

- adapter contracts
- fixture-based testing
- policy versioning
- explainable classifications
- reproducible bug reports with redacted paths

## Product Principles

### Reachability before age

Age is a policy input, never proof that a resource is dead.

A resource is cleanable only after AgentRinse fails to find a live root and
positively proves the action's preconditions.

### Unknown means protected

Permission failures, malformed provider state, command timeouts, missing
metadata, unsupported versions, and inconsistent observations must classify a
resource as `unknown` or `blocked`, never as cleanable.

### Explain every decision

Every finding must include:

- what was discovered
- how it was measured
- which roots were checked
- which policy matched
- why the proposed action is safe or blocked
- how much space is estimated to be reclaimed
- whether recovery is possible

### Plan before mutation

Discovery does not mutate. Planning does not mutate. Applying requires a
persisted plan or a freshly generated equivalent plan.

### Revalidate at the edge

The world can change between audit and apply. Every action must recheck its
critical facts immediately before mutation.

### Prefer owner APIs

Use stable provider, Git, Docker, and SQLite contracts before direct filesystem
manipulation.

### Never manufacture certainty

Estimated byte counts, inferred ownership, and heuristic ages must be labeled
as estimates or heuristics. AgentRinse should be conservative without being
vague.

### Cleanup is part of closeout

The tool should make it easy for agents and humans to remove terminal
worktrees as soon as ownership is clear, rather than deferring all cleanup to a
large risky sweep.

### Composable, not imperial

AgentRinse should hand broad system cleanup to Mole and leave provider-managed
session lifecycle to providers. The tool wins by joining context, not by owning
every deletion surface.

## Terminology

### Resource

A local object with identity, lifecycle, size, and cleanup behavior.

Examples:

- a Git worktree
- a `node_modules` directory inside a worktree
- a Codex thread rollout
- a Codex diagnostic SQLite database
- a Docker image
- a Docker build-cache record

### Root

Evidence that a resource is reachable and must be retained.

Examples:

- a live process has its current directory under the resource
- an active or pinned agent session references the resource
- the resource is the main Git worktree
- the worktree is dirty or locked
- a branch contains commits not present on a configured remote
- the user explicitly pinned the resource
- a running or stopped Docker container references an image

### Collector

Read-only code that discovers resources and facts.

### Protector

Read-only code that discovers roots and attaches protection reasons.

### Policy

Versioned rules that turn facts into classifications and candidate actions.

### Finding

The immutable result of evaluating one resource.

### Plan

A persisted, content-addressed set of proposed actions derived from findings.

### Action

One bounded mutation with explicit preconditions, risk, recovery behavior, and
expected effect.

### Run

An attempt to apply a plan.

### Quarantine

A same-filesystem holding area used for recoverable whole-resource removal.

### Pin

An explicit user decision that makes a resource a root.

### Risk class

The maximum consequence of an action:

- `safe`: rebuildable, provider-supported, or metadata-only
- `recoverable`: removes a resource but preserves a tested undo path
- `destructive`: no complete undo path
- `experimental`: behavior is provider/version-sensitive or not yet mature

### Confidence

The quality of the evidence supporting a finding:

- `certain`
- `high`
- `medium`
- `low`
- `unknown`

Confidence does not override risk. A `certain` destructive action remains
destructive.

## Resource State Model

Every resource is classified into exactly one state:

```text
discovered
  -> protected
  -> eligible
  -> blocked
  -> unknown
  -> ignored
```

Definitions:

- `protected`: at least one hard root exists
- `eligible`: no root exists and one or more policies permit an action
- `blocked`: policy permits cleanup but a required precondition is unmet
- `unknown`: available evidence is insufficient or inconsistent
- `ignored`: outside enabled adapters or explicitly excluded

An action transitions independently:

```text
planned
  -> revalidating
  -> skipped-stale
  -> applying
  -> applied
  -> failed
  -> rolled-back
  -> partially-applied
```

`partially-applied` is an error state requiring human-visible recovery
instructions. It must never be collapsed into success.

## Safety Invariants

These are hard product requirements.

### Global invariants

1. Audit and plan commands perform no cleanup mutation.
2. Apply never exceeds the plan's risk ceiling.
3. Apply never expands a path, resource set, or wildcard beyond the persisted
   plan.
4. Apply revalidates critical facts after acquiring the action lock.
5. A changed critical fact causes `skipped-stale`, not best-effort deletion.
6. Unknown state is protected.
7. AgentRinse never invokes `sudo`.
8. AgentRinse never kills a process.
9. AgentRinse never follows an unplanned symlink target.
10. AgentRinse never traverses outside an adapter's declared roots.
11. AgentRinse never deletes its own current working directory or an ancestor.
12. AgentRinse never cleans another concurrent AgentRinse run's resources.
13. Every applied action writes a durable result record.
14. Human-readable output is not the source of truth; the run manifest is.
15. A command interruption must leave enough state to identify completed and
    incomplete actions.
16. Artifact removal never operates on sockets, pipes, devices, or other
    special filesystem entries.
17. Plan authorization is rechecked immediately before artifact isolation and
    again before recursive removal.
18. A final synchronous inode gate immediately precedes production artifact
    removal.

### Git invariants

1. The main worktree is always protected.
2. A locked worktree is always protected unless a future explicit unlock
   command is separately authorized.
3. A dirty worktree is always protected from whole-worktree removal.
4. Untracked files count as dirty.
5. Staged changes count as dirty.
6. An in-progress merge, rebase, cherry-pick, revert, or bisect protects the
   worktree.
7. A worktree with a live process CWD or open critical Git file is protected.
8. A worktree referenced by a live, recent, pinned, or provider-protected
   session is protected.
9. A detached commit not proven reachable from a durable ref is protected.
10. A local branch with commits not proven present on a configured remote is
    protected.
11. AgentRinse does not delete branches or stashes.
12. Git administrative cleanup uses Git commands, not guessed `.git` paths.

### Provider invariants

1. Codex and Claude transcript contents are never parsed for cleanup intent.
2. Session files are never deleted directly in the MVP.
3. Provider configuration and authentication are never cleanup candidates.
4. Provider-native pins, locks, active states, and retention settings are
   roots.
5. Unsupported provider schema versions fail closed.
6. Database mutation requires the owning provider to be fully stopped.
7. Database compaction requires integrity checks and a rollback artifact.

### Docker invariants

1. Docker volumes are report-only by default.
2. Running containers are never removed.
3. Images referenced by any container are protected.
4. Build cache marked in-use is protected.
5. Docker cleanup is scoped to the active configured context.
6. An unavailable daemon produces a finding and does not fail other adapters.
7. AgentRinse never runs unfiltered `docker system prune -a --volumes`.

## Risk and Authorization Model

### Risk classes

| Class          | Meaning                                           | Default authorization |
| -------------- | ------------------------------------------------- | --------------------- |
| `safe`         | Rebuildable data or metadata-only owner operation | selectable            |
| `recoverable`  | Whole resource removed with tested undo           | explicit apply        |
| `destructive`  | User state removed without complete undo          | excluded              |
| `experimental` | Version-sensitive maintenance operation           | excluded              |

### Default command behavior

- `agentrinse audit`: read-only, all enabled adapters
- `agentrinse plan`: read-only, includes `safe` and `recoverable` candidates
- `agentrinse apply`: requires a plan and confirmation in an interactive TTY
- `agentrinse apply --yes`: non-interactive authorization
- `agentrinse apply --max-risk safe`: applies only safe actions
- `agentrinse clean`: shorthand for audit plus plan preview
- `agentrinse clean --apply`: creates and applies a fresh plan interactively
- `agentrinse clean --apply --yes --max-risk safe`: automation-safe closeout

There is no `--force` flag in the MVP. "Force" is too vague for a cleanup
product. Every override must name the exact protection or policy it changes.

Examples of acceptable future overrides:

- `--include-detached`
- `--allow-offline-vacuum`
- `--include-unlabeled-stopped-containers`

Each override remains subject to hard invariants.

## Architecture

### Recommended stack

- TypeScript
- ESM-only package
- Node.js 22 or newer
- pnpm
- Vitest
- `oxfmt`
- `oxlint`
- JSON Schema generated from canonical TypeScript contracts or maintained with
  compile-time equivalence tests
- no native dependency in the core package

Node.js 22 is the minimum because this is a new package in 2026 and should not
carry compatibility cost for retired runtimes. Native SQLite support must not
become an implicit requirement until its stability and packaging behavior are
verified during implementation.

### Runtime shape

AgentRinse is a single-process CLI with no daemon:

```text
CLI
  -> config loader
  -> adapter registry
  -> discovery engine
  -> root/protection engine
  -> policy engine
  -> finding renderer
  -> plan writer
  -> apply engine
       -> lock manager
       -> per-action revalidation
       -> action executor
       -> quarantine manager
       -> run journal
```

### Architectural boundaries

- Collectors gather facts but never classify or mutate.
- Protectors attach roots but never choose actions.
- Policies classify resources and propose action descriptors.
- Executors implement named actions but do not broaden policy.
- Renderers consume stable domain records and do not inspect the filesystem.
- Provider adapters own provider paths and schema interpretation.
- Git owns worktree administration.
- Docker owns Docker object mutation.
- The core owns orchestration, locks, plans, runs, and safety invariants.

### Proposed repository layout

```text
agentrinse/
  src/
    cli/
      commands/
        audit.ts
        plan.ts
        apply.ts
        clean.ts
        undo.ts
        purge.ts
        history.ts
        show.ts
        doctor.ts
        adapters.ts
        config.ts
      output/
      exit-codes.ts
    core/
      discovery.ts
      protection.ts
      policy.ts
      planning.ts
      applying.ts
      revalidation.ts
      locks.ts
      paths.ts
      sizes.ts
      time.ts
      errors.ts
    contracts/
      resource.ts
      finding.ts
      plan.ts
      run.ts
      adapter.ts
      config.ts
    adapters/
      git/
      codex/
      claude/
      cursor/
      copilot/
      zed/
      opencode/
      grok/
      docker/
      artifacts/
      runtimes/
      mole/
    policy/
      defaults.ts
      evaluator.ts
      pins.ts
      ignores.ts
    state/
      layout.ts
      atomic-json.ts
      journal.ts
      quarantine.ts
    testing/
      fake-clock.ts
      fake-processes.ts
      fixtures.ts
  schemas/
    finding.schema.json
    plan.schema.json
    run.schema.json
    config.schema.json
  test/
    fixtures/
    integration/
    e2e/
  docs/
    safety.md
    adapters.md
    automation.md
    recovery.md
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vitest.config.ts
```

Tests should mirror source ownership where practical.

## Core Contracts

### Resource identity

Resource IDs must be deterministic across unchanged audits.

```ts
export type ResourceKind =
  | "git-worktree"
  | "build-artifact"
  | "agent-session"
  | "agent-log-store"
  | "agent-runtime"
  | "docker-container"
  | "docker-image"
  | "docker-network"
  | "docker-volume"
  | "docker-build-cache"
  | "external-cleaner";

export type ResourceRef = {
  id: string;
  adapter: string;
  kind: ResourceKind;
  canonicalKey: string;
  displayName: string;
  path?: string;
  externalId?: string;
};
```

`id` should be:

```text
<adapter>:<kind>:<sha256(canonicalKey)>
```

The canonical key may contain an absolute path internally. Machine output may
redact it for sharing, but plan execution requires the exact key.

### Root evidence

```ts
export type RootEvidence = {
  code:
    | "user-pin"
    | "main-worktree"
    | "git-lock"
    | "dirty-worktree"
    | "unpushed-commit"
    | "unreachable-detached-commit"
    | "in-progress-git-operation"
    | "live-process-cwd"
    | "open-file"
    | "active-session"
    | "recent-session"
    | "pinned-session"
    | "provider-permanent"
    | "container-reference"
    | "in-use-cache"
    | "recent-resource"
    | "unknown-owner-state";
  source: string;
  observedAt: string;
  detail: string;
  evidenceRef?: string;
};
```

Root details must not include transcript contents or secret-bearing command
lines.

### Finding

```ts
export type FindingState = "protected" | "eligible" | "blocked" | "unknown" | "ignored";

export type Finding = {
  schemaVersion: 1;
  findingId: string;
  auditId: string;
  observedAt: string;
  resource: ResourceRef;
  state: FindingState;
  confidence: "certain" | "high" | "medium" | "low" | "unknown";
  roots: RootEvidence[];
  facts: Record<string, unknown>;
  matchedPolicy?: {
    id: string;
    version: number;
    reason: string;
  };
  candidateActions: ActionDescriptor[];
  measuredBytes?: number;
  estimatedReclaimBytes?: number;
  warnings: Diagnostic[];
};
```

### Action descriptor

```ts
export type ActionRisk = "safe" | "recoverable" | "destructive" | "experimental";

export type ActionDescriptor = {
  actionId: string;
  type: string;
  adapter: string;
  resourceId: string;
  risk: ActionRisk;
  description: string;
  expectedReclaimBytes?: number;
  recovery:
    | { mode: "none"; reason: string }
    | { mode: "rebuild"; command?: string }
    | { mode: "quarantine"; ttlSeconds: number }
    | { mode: "owner"; instructions: string };
  preconditions: Precondition[];
  parameters: Record<string, unknown>;
};
```

Action type names are public machine contracts. Examples:

- `artifacts.remove`
- `worktree.quarantine`
- `worktree.prune-registration`
- `docker.image.remove`
- `docker.container.remove`
- `docker.network.remove`
- `docker.build-cache.prune`
- `codex.logs.compact-offline`
- `runtime.remove-old-version`
- `mole.handoff`

### Adapter interface

```ts
export interface AgentRinseAdapter {
  readonly id: string;
  readonly version: number;
  probe(context: ProbeContext): Promise<AdapterProbe>;
  collect(context: CollectContext): AsyncIterable<ResourceSnapshot>;
  protect(resource: ResourceSnapshot, context: ProtectContext): Promise<RootEvidence[]>;
  propose(
    resource: ResourceSnapshot,
    roots: RootEvidence[],
    context: PolicyContext,
  ): Promise<ActionDescriptor[]>;
  revalidate(action: PlannedAction, context: RevalidationContext): Promise<RevalidationResult>;
  apply(action: PlannedAction, context: ApplyContext): Promise<ActionResult>;
  undo?(result: AppliedAction, context: UndoContext): Promise<UndoResult>;
}
```

Adapters are statically bundled in the MVP. Third-party adapter loading would
execute arbitrary local code and needs a separate trust design.

## Discovery and Reachability

### Discovery sequence

1. Load configuration and validate it.
2. Resolve platform capabilities.
3. Acquire a read-only audit ID and timestamp.
4. Probe every enabled adapter independently.
5. Collect resources with bounded concurrency.
6. Collect process ownership and configured pins once for reuse.
7. Attach provider and Git roots.
8. Evaluate versioned policy.
9. Write optional audit artifact.
10. Render results.

One adapter failure must not cancel unrelated adapters unless the failure
invalidates a global invariant.

### Process ownership

Process ownership is a critical shared fact.

macOS implementation:

- use `lsof` with bounded, parseable fields
- inspect current directories and open descriptors
- never parse free-form process display output when a structured form exists

Linux implementation:

- prefer `/proc/<pid>/cwd` and `/proc/<pid>/fd`
- handle permission failures as unknown ownership

Windows implementation:

- audit-only until a reliable ownership provider is implemented
- whole-worktree cleanup must fail closed without process ownership proof

The process collector must not:

- kill processes
- read process memory
- record environment variables
- persist full command lines by default

### Pins

Pins are user-owned GC roots.

Supported forms:

```json
{
  "pins": [
    { "path": "$HOME/src/project-worktree" },
    { "resourceId": "git:git-worktree:..." },
    { "gitRef": "refs/heads/release/2026.7" },
    { "dockerLabel": "agentrinse.keep=true" }
  ]
}
```

Pins never expire unless `expiresAt` is explicitly supplied.

## Plan Model

### Plan requirements

A plan is an immutable JSON document containing:

- schema version
- AgentRinse version
- policy version
- creation timestamp
- platform and capability summary
- config digest
- audit digest
- ordered actions
- explicit risk ceiling
- expected reclaim estimate
- per-action critical observations
- plan digest

Plans are stored under:

```text
$XDG_STATE_HOME/agentrinse/plans/<plan-id>.json
```

Fallback:

```text
$HOME/.local/state/agentrinse/plans/<plan-id>.json
```

### Plan identity

`planId` is a SHA-256 digest over canonical JSON excluding the `planId` field.

Canonicalization requirements:

- UTF-8
- lexicographically sorted object keys
- arrays retain semantic order
- timestamps normalized to RFC 3339 UTC
- integers for byte counts and durations
- no undefined values

### Plan order

Actions are ordered to minimize risk:

1. metadata-only actions
2. rebuildable artifact removal
3. Docker cache cleanup
4. recoverable worktree quarantine
5. provider maintenance
6. external cleaner handoff

An action may declare dependencies on earlier actions. Cycles invalidate the
plan.

### Plan staleness

Plans default to a 30-minute authorization window.

Expiration does not automatically make every observation invalid, but apply
must refuse an expired plan. If authorization expires after a run starts, each
not-yet-mutated action becomes `skipped-stale`.

Refresh:

- reruns discovery for planned resources
- preserves user selection where actions remain equivalent
- emits a new plan ID
- records the superseded plan ID

## Apply Engine

### Apply sequence

1. Load and schema-validate the plan.
2. Verify the plan digest.
3. Verify AgentRinse supports the plan schema and action types.
4. Verify the requested risk ceiling.
5. Acquire the global apply lock.
6. Create a run journal and fsync it.
7. For each action:
   1. acquire the resource lock
   2. revalidate critical facts
   3. record `revalidating`
   4. skip if facts, retention policy, or supported entry types changed
   5. recheck plan expiration
   6. record `applying`
   7. isolate the exact action target
   8. revalidate the isolated tree and plan expiration
   9. synchronously verify the inode and execute recursive removal
   10. verify postconditions
   11. record the result and fsync
   12. release the resource lock
8. Write the final run summary.
9. Release the global lock.

### Locks

State lock:

```text
$XDG_STATE_HOME/agentrinse/locks/apply.lock
```

Resource locks are keyed by resource ID.

Lock records include:

- PID
- process start identity where available
- hostname
- created timestamp
- command
- plan ID
- run ID

AgentRinse may recover its own stale lock only after proving the recorded
process identity no longer exists. It must not delete a lock based only on age.

### Failure policy

Default: continue independent actions after one action fails.

Stop conditions:

- run journal cannot be written
- plan integrity fails
- global safety capability disappears
- an action reports possible corruption
- a dependency action fails

`--fail-fast` is available for automation but does not alter rollback behavior.

## State and Filesystem Layout

Configuration:

```text
$XDG_CONFIG_HOME/agentrinse/config.json
```

State:

```text
$XDG_STATE_HOME/agentrinse/
  audits/
  plans/
  runs/
  quarantine/
  locks/
  pins.json
```

Cache:

```text
$XDG_CACHE_HOME/agentrinse/
  sizes/
  probes/
```

Defaults when XDG variables are unset:

```text
$HOME/.config/agentrinse
$HOME/.local/state/agentrinse
$HOME/.cache/agentrinse
```

Plans, run manifests, and recovery manifests are named user-facing artifacts,
so atomic JSON is appropriate for the MVP. AgentRinse must not create a
database solely to avoid several bounded manifest files.

Atomic write protocol:

1. create a temporary file in the destination directory
2. set owner-only permissions
3. write complete bytes
4. fsync the file
5. rename atomically
6. fsync the parent directory where supported

Default permissions:

- directories: `0700`
- manifests: `0600`

## Configuration

### Precedence

From highest to lowest:

1. command-line flags
2. project config explicitly selected with `--config`
3. nearest `.agentrinse.json`
4. user config
5. built-in defaults

Environment variables are limited to standard path and output behavior:

- `XDG_CONFIG_HOME`
- `XDG_STATE_HOME`
- `XDG_CACHE_HOME`
- `NO_COLOR`
- `FORCE_COLOR`
- `AGENTRINSE_CONFIG`

Avoid a large product-specific environment-variable surface.

### Initial config shape

```json
{
  "$schema": "https://agentrinse.com/schema/config-v1.json",
  "policy": {
    "maxRisk": "recoverable",
    "planTtl": "30m",
    "quarantineTtl": "7d",
    "recentSessionAge": "30d",
    "recentSessionCount": 50
  },
  "adapters": {
    "git": {
      "enabled": true,
      "scanRoots": [],
      "artifactTrimAge": "3d",
      "worktreeRemovalAge": "14d",
      "protectDetached": true,
      "protectUnpushed": true
    },
    "codex": {
      "enabled": true,
      "home": "$CODEX_HOME",
      "sessions": "report-only",
      "logs": "audit"
    },
    "claude": {
      "enabled": true,
      "home": "$CLAUDE_CONFIG_DIR",
      "sessions": "report-only"
    },
    "cursor": {
      "enabled": true,
      "userDataDir": "auto",
      "sessions": "report-only",
      "logs": "audit"
    },
    "copilot": {
      "enabled": true,
      "configDir": "$COPILOT_HOME",
      "sessions": "report-only",
      "logs": "audit"
    },
    "zed": {
      "enabled": true,
      "userDataDir": "auto",
      "sessions": "report-only",
      "logs": "audit"
    },
    "opencode": {
      "enabled": true,
      "dataDir": "auto",
      "sessions": "report-only",
      "snapshots": "audit"
    },
    "grok": {
      "enabled": true,
      "home": "$GROK_HOME",
      "sessions": "report-only",
      "logs": "audit"
    },
    "docker": {
      "enabled": true,
      "context": "current",
      "danglingImageAge": "14d",
      "buildCacheAge": "7d",
      "stoppedContainers": "report-only",
      "volumes": "report-only"
    },
    "mole": {
      "enabled": "auto",
      "mode": "handoff-only"
    }
  },
  "pins": [],
  "ignore": []
}
```

`$CODEX_HOME` falls back to `$HOME/.codex`.

`$CLAUDE_CONFIG_DIR` falls back to `$HOME/.claude`.

`$COPILOT_HOME` falls back to `$HOME/.copilot`.

`$GROK_HOME` falls back to `$HOME/.grok`.

Duration strings must use one documented parser and normalize to integer
seconds in plans.

### Project configuration

`.agentrinse.json` may:

- pin the repository or selected worktrees
- declare rebuildable artifact directories
- specify an artifact rebuild command for display
- opt a Docker Compose project into stopped-container cleanup
- add ignore patterns within the repository

Project config may not:

- lower global hard safety invariants
- enable transcript deletion
- enable Docker volume deletion
- authorize offline database mutation
- execute arbitrary hooks

## CLI Specification

### Global flags

```text
--config <path>
--adapter <id>          repeatable
--exclude-adapter <id>  repeatable
--json
--ndjson
--no-color
--quiet
--verbose
--timeout <duration>
--home <path>           test/support override, never implied
--version
--help
```

`--json` returns one complete JSON document.

`--ndjson` streams versioned event records and is preferred for long audits.

Human output goes to stdout. Diagnostics and progress go to stderr.

When stdout is not a TTY, color is disabled. Human output does not
automatically change to JSON; scripts must request the contract explicitly.

### `agentrinse audit`

Read-only discovery and classification.

```text
agentrinse audit
agentrinse audit --adapter git --adapter codex
agentrinse audit --json
agentrinse audit --save
agentrinse audit --paths "$HOME/src/project"
```

Key flags:

```text
--save
--paths <path>          repeatable
--include-protected
--min-size <bytes>
--state <state>         repeatable
```

Default human summary:

```text
AgentRinse audit

Reclaimable now       18.4 GiB
Recoverable cleanup   24.1 GiB
Protected             37 resources
Blocked                3 resources
Unknown                1 resource

WORKTREES
  9.8 GiB  eligible  project-a/task-17
           clean, inactive 21d, remote contains HEAD
           action: quarantine for 7d

  6.2 GiB  protected project-b/fix-auth
           active Codex thread, process cwd pid 48120

DOCKER
  unavailable
  context orbstack: daemon socket not found
```

### `agentrinse plan`

Create a persisted immutable plan.

```text
agentrinse plan
agentrinse plan --max-risk safe
agentrinse plan --finding <id>
agentrinse plan --adapter git --output ./rinse-plan.json
```

Selection flags:

```text
--finding <id>         repeatable
--resource <id>        repeatable
--action <type>        repeatable
--max-risk <risk>
--min-age <duration>
--min-size <bytes>
--output <path>
```

Plan creation must print the plan ID and exact apply command.

### `agentrinse apply`

Apply a persisted plan.

```text
agentrinse apply <plan-id-or-path>
agentrinse apply <plan-id> --yes
agentrinse apply <plan-id> --yes --max-risk safe
```

Flags:

```text
--yes
--max-risk <risk>
--only <action-id>     repeatable
--skip <action-id>     repeatable
--fail-fast
```

`--only` and `--skip` reduce the action set. They cannot add actions.

### `agentrinse clean`

Convenience workflow.

```text
agentrinse clean
```

Equivalent to:

```text
agentrinse audit
agentrinse plan
```

It prints the preview but performs no mutation.

```text
agentrinse clean --apply
```

Creates a fresh plan and applies it after interactive confirmation.

```text
agentrinse clean --apply --yes --max-risk safe
```

Automation form suitable for agent closeout.

### Closeout profile

The built-in `closeout` profile scopes cleanup to work associated with the
current repository and is designed for use at the end of an agent task:

```text
agentrinse clean --profile closeout
agentrinse clean --profile closeout --apply --yes --max-risk safe
```

The profile:

- starts from the current repository and provider-linked worktrees
- does not scan unrelated configured roots
- protects the current worktree and all live ownership
- trims eligible rebuildable artifacts
- reports clean terminal worktrees but does not quarantine them under a
  `safe` risk ceiling
- emits one compact machine-readable closeout summary when `--json` is used

The profile does not infer that a task is finished. The caller remains
responsible for invoking it only after its work has landed, been handed off, or
otherwise reached a terminal state.

### `agentrinse undo`

Undo recoverable actions from a run.

```text
agentrinse undo <run-id>
agentrinse undo <run-id> --action <action-id>
agentrinse undo <run-id> --yes
```

Undo revalidates the destination and refuses to overwrite new state.

### `agentrinse purge`

Purge expired quarantine entries.

```text
agentrinse purge
agentrinse purge --expired --apply
agentrinse purge --run <run-id> --apply
```

Preview is the default. Purge is destructive and requires explicit apply.

### `agentrinse history`

```text
agentrinse history
agentrinse history --json
agentrinse history --since 30d
```

### `agentrinse show`

```text
agentrinse show plan <plan-id>
agentrinse show run <run-id>
agentrinse show resource <resource-id>
```

### `agentrinse doctor`

Validates:

- state-directory permissions
- config schema
- required binaries
- provider path readability
- Git version and porcelain support
- process ownership capability
- Docker CLI/context/daemon
- quarantine filesystem behavior
- stale AgentRinse locks
- schema compatibility
- optional Mole presence/version

Doctor does not repair or clean unless a future subcommand explicitly names
the repair.

### `agentrinse adapters`

```text
agentrinse adapters
agentrinse adapters --json
```

Reports enabled, detected, available, degraded, unsupported, and disabled
adapters.

### `agentrinse config`

```text
agentrinse config show
agentrinse config validate
agentrinse config path
agentrinse config init
```

`config init` does not overwrite an existing file.

## Exit Codes

| Code  | Meaning                                                   |
| ----- | --------------------------------------------------------- |
| `0`   | command completed; no actionable failure                  |
| `1`   | command or one or more requested actions failed           |
| `2`   | invalid arguments or invalid configuration                |
| `3`   | findings exist and `--fail-on-findings` was requested     |
| `4`   | plan is stale, expired, or failed revalidation            |
| `5`   | operation blocked by active ownership or safety invariant |
| `6`   | unsupported platform, provider, schema, or action         |
| `7`   | run is partially applied and needs recovery               |
| `130` | interrupted by SIGINT                                     |

Adapter degradation does not by itself make `audit` exit nonzero. The JSON
summary records degraded adapters. `--strict` may turn degradation into exit
code `1`.

## Git Worktree Adapter

### Discovery

Discover worktrees through repositories found from:

- configured scan roots
- current working directory
- provider-managed worktree roots
- Git common directories referenced by discovered worktrees

Use:

```text
git worktree list --porcelain -z
```

Do not parse the human table.

Resource facts include:

- worktree path
- canonical repository common directory
- main or linked status
- HEAD
- branch or detached status
- lock and lock reason
- prunable status and reason
- filesystem size
- modification/activity observations
- Git operation state
- dirty tracked, staged, untracked, and ignored counts
- assume-unchanged and skip-worktree index flags
- stash count associated with the repository
- upstream and ahead/behind counts where configured
- reachability of HEAD from durable refs
- provider session references
- process ownership

### Unpushed proof

A branch is not cleanable merely because the working tree is clean.

Protection logic:

1. If there is no upstream, protect unless HEAD is proven reachable from a
   configured remote ref.
2. If upstream exists and local is ahead, protect.
3. If detached, protect unless HEAD is reachable from another durable local
   ref and the policy explicitly permits detached cleanup.
4. Network fetch is not performed by default. The result is relative to local
   remote-tracking refs and must say so.
5. `--fetch` may be a future explicit read-only option.

### Artifact trimming

Artifact cleanup retains the worktree but removes rebuildable heavy paths.

Built-in candidates:

- `node_modules`
- `.pnpm-store` only when project-local
- `dist`
- `dist-runtime`
- `build`
- `.next`
- `.turbo`
- `.cache`
- `coverage`
- Rust `target`
- Swift `.build`
- Python `.venv` only when explicitly declared rebuildable

Rules:

- project config and lockfiles inform the rebuild hint
- never delete a symlink target
- never cross a mount boundary
- never delete artifacts in an active worktree
- recent projects are unselected by default
- unknown custom directories are not inferred from size alone
- root package-manager stores are separate resources, not child artifacts

Default policy:

- candidate age: 3 days since last worktree activity
- minimum size: 256 MiB
- risk: `safe`
- recovery: rebuild

### Whole-worktree cleanup

Default eligibility:

- linked worktree, not main
- unlocked
- clean including untracked and ignored files
- no assume-unchanged or skip-worktree index flags
- no in-progress Git operation
- no live process ownership
- no provider root
- no user pin
- no unpushed or unreachable commit
- older than 14 days
- repository common directory is available and healthy

Action sequence:

1. Revalidate all eligibility facts.
2. Record Git metadata and filesystem identity.
3. Create a recovery ref under
   `refs/agentrinse/quarantine/<run-id>/<resource-short-id>`.
4. Move the worktree directory into same-filesystem quarantine atomically.
5. Ask Git to repair/prune the now-missing worktree registration using its
   documented commands.
6. Verify the original path is absent and recovery metadata is complete.
7. Retain quarantine data until TTL expiry.

The exact Git command sequence must be validated against current Git behavior
in implementation tests. If an atomic same-filesystem move is impossible,
whole-worktree quarantine is blocked. AgentRinse must not silently copy and
delete large worktrees across filesystems.

### Undo

Undo requires:

- quarantine entry still exists
- original destination does not exist
- repository common directory remains valid
- recovery ref still points to the recorded commit

Undo sequence:

1. move quarantined bytes back to the original path
2. repair or re-add the worktree through Git
3. verify HEAD, branch/detached state, and clean status
4. remove the temporary recovery ref only after verification

If the original path is occupied, undo stops and prints an alternate restore
command. It never overwrites.

## Codex Adapter

### Ownership boundary

Codex owns thread lifecycle, archive behavior, provider configuration, and
application-managed worktrees.

AgentRinse owns:

- cross-tool audit
- session-to-worktree root discovery
- storage diagnostics
- policy coordination
- safe artifact cleanup inside otherwise protected worktrees
- future explicit offline compaction

### Discovery

Detect:

- effective `CODEX_HOME`
- supported state database locations
- session and archived-session trees
- managed worktree roots
- logs databases and WAL/SHM companions
- installed Codex runtime/application versions where safely discoverable
- live Codex CLI, desktop, and app-server processes

### Session handling

MVP behavior: report-only.

AgentRinse may read provider metadata needed to establish:

- thread ID
- active/archived state
- update timestamp
- pinned/permanent state where exposed
- linked worktree CWD

It must not:

- inspect prompt or response contents
- infer importance from transcript text
- delete JSONL
- rewrite SQLite thread metadata
- simulate archive behavior with raw filesystem moves

### Worktree coordination

Codex-managed worktrees discovered by the Git adapter receive Codex roots:

- active thread
- pinned chat
- in-progress run
- permanent worktree
- recent unarchived thread within policy

AgentRinse should report when Codex's native configured worktree limit is
likely to reclaim a resource itself. Native lifecycle candidates are lower
priority than AgentRinse-specific artifact trimming.

### Logs database audit

Read-only facts:

- database path and size
- WAL and SHM size
- SQLite page size
- page count
- free-list page count
- estimated free bytes
- free-page ratio
- integrity-check capability
- active owner processes
- last modification time

Audit uses read-only/query-only access and a short timeout.

Suggested finding threshold:

- estimated free bytes at least 512 MiB, and
- free-page ratio at least 25 percent

The finding says "offline compaction opportunity", not "corruption" or
"wasted logs".

### Offline compaction

Not in MVP. Target: experimental Phase 4.

Required preconditions:

- all Codex CLI, desktop, and app-server processes stopped
- no open descriptor for database, WAL, or SHM
- schema version supported
- sufficient free disk for a second compacted copy
- quick integrity check succeeds
- explicit `--allow-offline-vacuum`
- plan risk `experimental`

Preferred implementation:

1. open source database read-only and verify
2. use `VACUUM INTO` to a sibling temporary destination where supported
3. verify compacted database integrity and expected tables
4. fsync destination
5. atomically exchange or rename with a retained backup
6. preserve rollback copy until quarantine TTL
7. never delete WAL/SHM manually unless SQLite ownership rules prove it safe

Running `VACUUM` directly against the canonical file is not sufficient for the
product-grade implementation.

## Claude Adapter

### Ownership boundary

Claude Code owns transcript retention and orphaned worktree cleanup through its
settings and runtime.

AgentRinse owns:

- cross-tool inventory
- Claude session-to-worktree roots
- Git safety analysis
- artifact trimming
- explanation of native retention behavior

### Discovery

Detect:

- effective Claude config directory
- project/session metadata
- `.claude/worktrees` roots
- user-created `--worktree` locations when discoverable
- live Claude processes
- configured `cleanupPeriodDays`

### Session handling

MVP behavior: report-only.

AgentRinse must distinguish:

- provider-managed orphaned worktrees
- user-created worktrees
- worktrees linked to resumable sessions
- worktrees with unpushed changes
- unknown metadata due to unsupported formats

Provider settings parsing failures protect affected resources.

### Native cleanup interaction

If Claude is expected to remove an orphaned worktree under its configured
retention policy, AgentRinse reports:

```text
native cleanup expected
```

It may still propose safe artifact trimming. It should avoid racing the
provider's startup cleanup and must revalidate path existence before action.

## Cursor Adapter

### Ownership boundary

Cursor owns editor workspace state, chat/session databases, extensions,
authentication, settings, and cloud-agent state.

AgentRinse owns:

- storage inventory
- workspace-path correlation
- stale log reporting
- database fragmentation diagnostics
- explanation of which workspace protects a storage directory

### Discovery

Detect the configured or platform-default Cursor user-data directory.

Initial platform defaults:

- macOS: `$HOME/Library/Application Support/Cursor`
- Linux: `$HOME/.config/Cursor`
- Windows: `%APPDATA%\Cursor`

Inventory:

- `User/workspaceStorage`
- `User/globalStorage`
- editor logs
- `state.vscdb`, backup, WAL, and SHM companions
- workspace metadata that maps a storage hash to a project path

### Safety policy

All Cursor workspace and global databases are report-only through 1.0.

Reasons:

- chat history is tied to workspace storage and workspace paths
- deleting or replacing database files can make history inaccessible
- global and workspace databases may reference each other
- the storage schema is editor-internal and version-sensitive

AgentRinse may report:

- total bytes by workspace
- missing workspace paths
- old log directories
- SQLite free-page estimates using read-only access
- active Cursor processes and open descriptors
- database backup duplication

It must not:

- delete workspace storage because the project path is missing
- delete `state.vscdb` or `state.vscdb.backup`
- compact a database while Cursor or Cursor helpers are running
- treat a missing workspace path as proof that its chat history is disposable

Future log cleanup may become `safe` after versioned retention tests. Future
offline compaction remains `experimental` and requires a rollback copy.

## GitHub Copilot Adapter

### Ownership boundary

GitHub Copilot CLI owns its session lifecycle, cloud synchronization,
configuration, authentication, logs, custom agents, skills, and plugins.
Editor-hosted Copilot extensions remain owned by their editor.

### Discovery

Detect the Copilot CLI configuration directory through the supported CLI
configuration contract, defaulting to `$HOME/.copilot`.

Inventory:

- local session state
- local fallback/session index data
- CLI logs
- customizations and plugin cache size
- active Copilot CLI processes
- editor extension log locations as separately owned resources

### Safety policy

- session state is report-only
- configuration, authentication, custom agents, skills, and plugins are always
  protected
- cloud-synced status is not evidence that a local session may be deleted
- editor extension logs inherit the host editor's lifecycle
- CLI logs may become a safe age-filtered action after exact current CLI
  retention behavior is tested

AgentRinse should prefer Copilot CLI commands or documented configuration
paths over inspecting undocumented editor database keys.

## Zed Adapter

### Ownership boundary

Zed owns its user-data database, agent threads, ACP state, extensions,
settings, authentication, and editor logs.

### Discovery

Resolve the user-data directory from the running command/configuration when
available. Platform defaults:

- macOS: `$HOME/Library/Application Support/Zed`
- Linux: `$XDG_DATA_HOME/zed`, normally `$HOME/.local/share/zed`
- Windows: `%LOCALAPPDATA%\Zed`

The `zed --user-data-dir <DIR>` option means the default location is not
authoritative. If a non-default running instance cannot be resolved,
AgentRinse reports incomplete discovery.

Inventory:

- database files and companions
- logs, including ACP logs
- extensions and downloaded runtime assets
- active Zed/headless processes
- recent project and workspace references when exposed through supported data

### Safety policy

- database and agent-thread state are report-only
- extensions are package-manager-owned and not arbitrary cache candidates
- ACP logs may contain tool messages or sensitive context and are never parsed
  for cleanup intent
- log cleanup is disabled until a tested retention boundary exists
- no database compaction while Zed or a Zed headless server is running

## OpenCode Adapter

### Ownership boundary

OpenCode owns sessions, the application database, configuration,
authentication, plugins, share state, and snapshot-based undo behavior.

AgentRinse gives OpenCode a dedicated adapter because snapshot repositories can
become one of the largest agent-generated local resources.

### Discovery

Prefer owner commands:

```text
opencode debug paths
opencode db path
```

Fallback data location at the time of research:

```text
$HOME/.local/share/opencode
```

Inventory:

- application database and WAL/SHM companions
- sessions and logs
- snapshot repositories
- Git object/pack allocation
- orphan-looking temporary pack files
- active OpenCode, server, desktop, and snapshot Git processes
- whether the captured project path contains the OpenCode data directory

### Snapshot policy

Snapshots are user-visible recovery state, not ordinary build cache.

MVP behavior:

- report snapshot size by project/repository
- report rapid or extreme growth
- detect recursive/self-capture risk
- report stale temporary pack candidates
- explain the OpenCode setting that controls snapshots
- never run Git garbage collection inside a snapshot repository
- never delete snapshot objects or packs

Future cleanup requires one of:

1. a documented OpenCode owner command with dry-run and exact scope
2. an upstream storage contract proving which snapshot data is unreachable
3. export and restore tests showing that selected session undo remains intact

`opencode uninstall --dry-run` is useful evidence for owner paths, but
AgentRinse must never translate an uninstall plan into routine cleanup.

### Database policy

The OpenCode database is report-only through 1.0. Concurrent processes and
network filesystems make SQLite ownership especially important.

Any future compaction follows the same offline backup, integrity, and rollback
requirements as Codex and Cursor.

## Grok Build Adapter

### Ownership boundary

Grok Build owns sessions, configuration, authentication, plugins, MCP/LSP
state, ACP behavior, logs, and its internal task runtime.

Grok Build is a newly open-sourced product. AgentRinse support must pin exact
tested versions and inspect the public source before expanding beyond audit.

### Discovery

Resolve `GROK_HOME`, defaulting to `$HOME/.grok`.

Known configuration:

```text
$GROK_HOME/config.toml
```

Inventory only paths confirmed by the installed version or matching source:

- session/task state
- logs
- caches and downloaded runtime assets
- plugin data
- active `grok` and ACP processes
- project/worktree references

### Safety policy

- configuration and authentication are always protected
- sessions and task state are report-only
- plugin data is owner-managed
- logs may be classified only after their content and retention contract are
  understood
- version mismatch degrades the adapter to directory-level size reporting
- no mutation in the initial adapter

The adapter should expose the installed Grok Build version and the source
contract version used for interpretation in every finding.

## Docker Adapter

### Probe

Probe independently:

- Docker CLI presence
- selected context
- endpoint
- daemon availability
- server version
- builder availability

An unavailable daemon returns a degraded adapter record with the exact failed
capability.

### Resource inventory

Collect:

- running and stopped containers
- images and tags
- networks
- volumes
- build cache
- labels
- creation and last-use facts exposed by Docker
- reference relationships
- estimated reclaimable size

Prefer Docker JSON formats or APIs. Never scrape tables.

### Default policy

#### Images

Eligible:

- dangling
- older than 14 days
- not referenced by any container
- not pinned by label

Non-dangling unused images remain report-only until a user opts in.

#### Build cache

Eligible:

- not in use
- older than 7 days
- filtered through Docker's supported prune filters

Default risk: `safe`.

#### Containers

Report-only through the initial releases.

A future exact-container removal action may be proposed only when:

- stopped
- older than 14 days
- labeled `agentrinse.cleanup=true`
- not part of an active Compose project
- no protected volume relationship

Even with those facts, removal is `destructive` unless AgentRinse can generate
and validate a complete recreation descriptor. Unlabeled stopped containers
remain report-only.

#### Networks

Eligible only when:

- unused
- not a built-in network
- older than 14 days
- labeled for cleanup or associated only with selected eligible containers

#### Volumes

Always report-only in 1.0.

The output should explain that "unused by a container" is not proof that a
volume's data is disposable.

### Execution

Use the narrowest owner command for each selected resource. Do not replace
resource-specific plans with one broad system prune.

Every command must:

- pass arguments as an argv array
- use exact resource IDs or reviewed filters
- record Docker context and server identity
- revalidate references immediately before removal
- capture structured results where available

## Agent Runtime Adapter

Purpose: find superseded installed versions and staging directories from Codex,
Claude, and future agent tools.

MVP behavior:

- audit installed versions
- identify currently running executable paths
- retain current plus two previous versions
- report stale staging directories

Removal requirements:

- executable is not running
- no open file descriptors
- version is not configured as active
- version is older than 14 days
- install layout is a supported exact pattern

Unknown install managers are report-only. AgentRinse must not guess inside
Homebrew, npm global, Volta, mise, asdf, or system package-manager ownership.
Where possible it should recommend the owning package manager's command.

## Mole Adapter

Mole is an optional external handoff, not an embedded dependency.

Probe:

- executable presence
- version
- supported dry-run command

MVP behavior:

- suggest `mo purge --dry-run` for broad project artifact cleanup
- suggest `mo clean --dry-run` for general macOS cleanup
- optionally launch the command only after explicit user selection
- record exit status and log location

AgentRinse does not:

- copy Mole rules
- vendor Mole source
- link to Mole code
- parse unstable decorative terminal output as a data contract
- claim that Mole actions are recoverable by AgentRinse

External actions appear separately in plans and are never selected by
non-interactive `--max-risk safe` automation.

## Quarantine and Recovery

### Purpose

Quarantine provides a grace period for whole-resource cleanup. It is not
intended for rebuildable caches because retaining those bytes would defeat the
cleanup.

Use quarantine for:

- whole worktrees
- provider database backups during offline compaction
- recoverable old runtime directories when owner layout permits

Do not quarantine:

- `node_modules`
- build output
- Docker cache
- Docker images
- owner-managed temporary metadata

### Default TTL

Default: 7 days.

No daemon purges in the background. Expired entries are purged only by:

- explicit `agentrinse purge --expired --apply`
- a future separately installed scheduler
- a future interactive prompt during cleanup

### Quarantine manifest

Each entry records:

- entry ID
- run ID and action ID
- original path
- quarantine path
- filesystem/device identity
- recorded size
- resource metadata
- recovery ref or owner recovery instruction
- created and expiry timestamps
- verification results
- purge state

### Disk-pressure tradeoff

An atomic rename does not reclaim disk until purge. AgentRinse must say this
plainly.

The human summary separates:

- bytes removed from active paths
- bytes immediately reclaimed
- bytes pending quarantine expiry

For severe disk pressure, the user may choose immediate destructive purge as a
separate action. It is never smuggled into worktree apply.

## Security and Privacy

### Local-only default

AgentRinse performs no network request by default except owner CLI operations
that the user explicitly enabled.

No telemetry.

No crash upload.

No analytics identifier.

No account.

No hosted inventory.

### Sensitive data policy

AgentRinse records metadata, not contents.

It must not persist:

- transcript text
- source file contents
- environment variables
- auth tokens
- full process command lines by default
- Docker secret contents
- Git credential material

Paths can reveal personal data. Shareable reports must support:

```text
agentrinse audit --json --redact
```

Redaction should:

- replace the home path with `$HOME`
- hash repository and resource identifiers with a report-specific salt
- remove hostnames
- preserve sizes, states, reason codes, and adapter versions

Executable plans cannot be redacted because exact resource identity is
required.

### Path safety

Before filesystem mutation:

1. resolve the planned parent and leaf without following unexpected symlinks
2. compare device and inode identity with the plan where available
3. reject paths outside adapter roots
4. reject `/`, `$HOME`, state roots, config roots, and their ancestors
5. reject mount points unless the action explicitly owns one
6. use `lstat` semantics for deletion
7. use descriptor-relative operations where Node permits reliable use

No action may execute a path as shell text.

### Threat model

AgentRinse must defend against:

- malicious repository names and paths
- newlines and terminal escapes in filenames
- symlink swaps between planning and apply
- TOCTOU races
- stale PID reuse
- malformed Git or provider metadata
- Docker context switching between plan and apply
- interrupted writes
- concurrent cleanup runs
- compromised project configuration attempting to broaden scope
- command output designed to confuse a parser

It does not claim to defend against:

- a malicious user with the same account modifying state during apply
- a compromised root account
- a malicious replacement of trusted owner binaries

### Project config trust

Project config is data only.

It cannot contain:

- shell commands to execute
- JavaScript modules
- executable hooks
- arbitrary adapter imports

Rebuild commands are display hints unless a future separately reviewed command
runner is designed.

## Output Contracts

### JSON envelope

```ts
export type CommandEnvelope<T> = {
  schemaVersion: 1;
  command: string;
  agentrinseVersion: string;
  startedAt: string;
  completedAt: string;
  status: "ok" | "degraded" | "failed";
  data: T;
  diagnostics: Diagnostic[];
};
```

### Diagnostic

```ts
export type Diagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  adapter?: string;
  resourceId?: string;
  remediation?: string;
};
```

Diagnostic codes are stable. Human messages may improve without a breaking
schema change.

Examples:

- `DOCKER_DAEMON_UNAVAILABLE`
- `CODEX_SCHEMA_UNSUPPORTED`
- `PROCESS_OWNERSHIP_INCOMPLETE`
- `WORKTREE_DIRTY`
- `WORKTREE_UNPUSHED`
- `PLAN_EXPIRED`
- `ACTION_REVALIDATION_CHANGED`
- `QUARANTINE_CROSS_DEVICE`

### NDJSON events

```text
command.started
adapter.probed
diagnostic.reported
resource.discovered
finding.completed
plan.action-selected
action.revalidating
action.started
action.completed
action.skipped
action.failed
command.completed
```

Every event includes:

- schema version
- event type
- timestamp
- command/run ID
- sequence number

Once `command.started` is emitted, `command.completed` is always the terminal
record, including a `failed` status when audit or persistence fails.

### Output compatibility

Breaking changes to:

- schema meaning
- required fields
- action type names
- diagnostic codes used for control flow
- exit-code meaning

require a major version or a versioned schema migration.

Adding optional fields is backward-compatible.

## Performance

### Targets

On a typical developer machine:

- CLI startup under 250 ms warm, under 750 ms cold
- initial findings visible within 1 second
- common audit under 5 seconds excluding deep size measurement
- bounded memory below 200 MiB for 100,000 discovered resources
- cancellation response within 1 second

These are target budgets, not release blockers until representative benchmarks
exist.

### Scan strategy

- scan known roots, not the entire home directory
- reuse one process-ownership snapshot per audit
- use bounded concurrency
- stream resources and findings
- cache expensive size measurements using path identity and mtime facts
- invalidate caches conservatively
- cap external command duration
- do not recursively inspect transcript contents

### Size semantics

Report both where possible:

- logical bytes
- allocated bytes

Use allocated bytes for estimated disk reclamation when the platform exposes
them reliably. Label estimates.

Hard links, sparse files, APFS clones, Docker accounting, and filesystem
compression mean sums may not equal actual free-space change.

## Platform Support

### Tier 1: macOS

Required for 0.1.0 and later:

- APFS and common local filesystems
- `lsof` ownership proof
- Codex and Claude default layouts
- Docker Desktop and OrbStack contexts
- optional Mole handoff

### Tier 2: Linux

Supported from 0.1.0 with packaged Linux proof:

- `/proc` process ownership
- `lsof` fallback when hardened procfs prevents a complete scan
- standard XDG paths
- Docker Engine
- Codex and Claude layouts
- no Mole adapter
- mutation remains blocked if neither `/proc` nor `lsof` proves ownership

### Tier 3: Windows

Audit-only before 1.0:

- audit-only first
- WSL treated as Linux within the WSL filesystem
- native Windows worktree mutation blocked until process ownership, path
  identity, and atomic quarantine are proven

## Testing Strategy

### Unit tests

Cover:

- duration and byte parsing
- canonical JSON and plan digests
- risk ceiling comparisons
- policy evaluation
- root merging and deterministic ordering
- path boundary checks
- symlink rejection
- config precedence
- redaction
- exit-code selection

### Property tests

Properties:

- adding a root cannot make a resource more cleanable
- lowering risk ceiling cannot add actions
- refreshing an unchanged plan preserves action identity
- reordering discovery input does not change canonical findings
- redaction never reveals the original home path
- apply cannot target a resource absent from the plan

### Git integration fixtures

Create temporary repositories covering:

- main and linked worktrees
- clean and dirty states
- tracked, staged, and untracked changes
- stashes
- branches with and without upstreams
- ahead, behind, and diverged branches
- detached reachable and unreachable commits
- locked worktrees
- missing/prunable worktrees
- submodules
- in-progress merge/rebase/cherry-pick
- paths with spaces, tabs, newlines, and Unicode
- active process CWD
- quarantine, prune/repair, and undo

No integration test may operate on a developer's real repositories.

### Provider fixtures

Use synthetic homes and redacted copies representing supported schemas.

Tests cover:

- missing provider
- malformed config
- unsupported schema
- active and archived sessions
- session-to-worktree links
- pinned/permanent state
- provider process active
- SQLite database, WAL, free pages, and locked access
- Cursor workspace-path mapping and missing-project protection
- Copilot CLI local-session and log separation
- Zed custom user-data directories
- OpenCode snapshot growth and self-capture detection
- Grok Build version-gated path discovery
- no transcript content in output or run manifests

Codex contract tests must be refreshed against current upstream source before
shipping provider mutations.

### Docker tests

Unit tests use a fake structured Docker client.

Integration tests run in an isolated disposable Docker environment and cover:

- daemon unavailable
- alternate context
- dangling and referenced images
- in-use and old build cache
- labeled and unlabeled stopped containers
- protected volumes
- context changes between plan and apply

### Fault injection

Simulate:

- SIGINT after every journal step
- permission failure
- disk full
- rename failure
- cross-device move
- target recreated before undo
- provider starts between plan and apply
- Git state changes during revalidation
- Docker container begins referencing an image
- corrupted plan digest
- stale lock with PID reuse

### Snapshot tests

Human output may use focused snapshots.

Machine output must use schema validation and semantic assertions, not only
large snapshots.

### Destructive test policy

All destructive tests use temporary roots or disposable containers.

The test suite must contain a guard that refuses a destructive fixture when its
resolved root is:

- `/`
- the real home directory
- a parent of the repository
- outside the test temporary directory

## Observability and History

AgentRinse's observability is local and user-owned.

Every run records:

- selected actions
- precondition results
- start and end timestamps
- bytes estimated and observed
- skipped/stale actions
- failures and recovery instructions
- AgentRinse, adapter, provider, Git, and Docker versions

Run history must not store captured command output without redaction. Store
structured facts and a bounded diagnostic excerpt only where necessary.

History retention default: 90 days or 500 runs, whichever is reached first.

History cleanup is itself a safe AgentRinse action and never deletes
quarantine metadata required for a live entry.

## Packaging and Release

### Package metadata

Recommended:

```json
{
  "name": "agentrinse",
  "type": "module",
  "bin": {
    "agentrinse": "./dist/cli.js"
  },
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/vincentkoc/agentrinse.git"
  },
  "homepage": "https://agentrinse.com",
  "bugs": {
    "url": "https://github.com/vincentkoc/agentrinse/issues"
  }
}
```

### Distribution

Reservation release:

- publish `0.0.0` once from an authenticated maintainer machine
- make no supported-use claim for `0.0.0`
- use the package only to reserve the unscoped npm name and unlock trusted
  publisher configuration

Supported `0.1.0` release:

- publish through GitHub Actions trusted publishing
- `npm install --global agentrinse`
- `npx agentrinse audit`
- attach a checksummed source/package archive to the GitHub release

By `0.3.0`:

- Homebrew formula in `vincentkoc/tap`
- formula installation and upgrade smoke tests
- signed or provenance-backed checksummed release artifacts

Later:

- deb/rpm packages if Linux demand justifies them
- standalone executable only if packaging does not compromise inspectability

### Supply chain

Required:

- npm trusted publishing through GitHub Actions OIDC
- npm provenance
- no long-lived npm token in CI
- protected release environment
- a one-time `0.0.0` bootstrap before trusted publishing is configured
- public repository metadata matching the publisher
- generated checksums for release archives
- dependency review and lockfile
- minimal runtime dependency set
- `npm pack` and `publint` verification
- smoke install of the packed artifact before publish

### Versioning

Use semantic versioning.

Before 1.0:

- schema and action contracts may evolve, but every release documents changes
- plans are executable only by declared compatible versions
- `0.0.0` is a reservation release and is not a supported product version
- each supported minor release must satisfy its complete milestone exit
  criteria before its tag is published

At 1.0:

- JSON schemas, action names, diagnostic codes, and exit-code meanings become
  compatibility commitments

## Documentation Set

The repository should contain:

- `README.md`: product promise and quick start
- `docs/safety.md`: invariants and risk model
- `docs/adapters.md`: supported tools and ownership boundaries
- `docs/automation.md`: JSON, NDJSON, exit codes, and agent usage
- `docs/recovery.md`: quarantine, undo, partial-run recovery
- `docs/configuration.md`: complete config reference
- `docs/development.md`: fixtures and destructive-test guardrails
- JSON Schemas published at stable URLs

The website should begin as documentation and package installation, not a
marketing-heavy landing page.

## Milestones

### `0.0.0`: package reservation

Deliver:

- public npm package record for `agentrinse`
- package metadata pointing to the public repository
- explicit unsupported reservation-release messaging
- locally authenticated bootstrap publish with 2FA
- no long-lived npm token committed or stored in GitHub

Exit criteria:

- anonymous `npm view agentrinse@0.0.0` succeeds
- the package contains only intended files
- the installed binary reports `0.0.0`
- npm trusted publishing can be configured for the repository and release
  workflow

### `0.1.0`: operational safe-artifact release

Deliver:

- existing provider, Git, Docker, and artifact inventory
- exact configured rebuildable-artifact removal
- content-addressed plans, expiry, locks, revalidation, isolation, and durable
  run journals
- `agentrinse config init` and config validation
- `agentrinse doctor` with platform, dependency, configuration, state, and
  stale-lock diagnostics
- `agentrinse history` and `agentrinse show`
- explicit stale-lock inspection and owned recovery command
- actionable partial-run recovery guidance
- JSON, NDJSON, and redacted audit output
- shell completion generation
- clear macOS, Linux, WSL, and native Windows support contract
- checksummed GitHub release artifact
- trusted npm publish with provenance
- real read-only workstation dogfood plus one disposable-project canary apply

Exit criteria:

- fresh npm and `npx` installs work
- operator setup does not require hand-authoring the first config file
- doctor identifies every missing prerequisite without mutating
- history and show explain completed, skipped, failed, and partial actions
- representative local audit inventories provider state without transcript
  content
- no transcript content appears in outputs
- Docker unavailability is isolated
- macOS and Linux packaged proof pass
- all artifact actions remain `safe`
- no worktree, provider store, Docker resource, branch, stash, credential,
  plugin, skill, memory, or volume is removed

### `0.2.0`: agent-aware reachability

Deliver:

- complete Git worktree state collection: main, clean, dirty, staged,
  untracked, locked, prunable, detached, and in-progress operations
- local and configured-remote reachability proof for worktree HEADs
- explicit unpushed and unknown-remote protection
- live process cwd and file-descriptor roots
- Codex and Claude session-to-worktree roots without reading transcript
  content
- provider-managed worktree and pin roots
- deterministic root explanations and candidate suppression
- agent closeout audit profile that scopes one repository/task without
  inferring task completion
- Mole availability probe and external handoff suggestions on macOS
- no new mutating action types

Exit criteria:

- every dirty, active, pinned, locked, unpushed, detached-risk, or
  insufficiently understood worktree is protected
- representative Codex and Claude fixtures link sessions to worktrees without
  emitting transcript content
- adding a root can never make a resource more cleanable
- changing provider/session state after audit invalidates affected candidates
- worktree removal remains unavailable

### `0.3.0`: recoverable worktrees

Deliver:

- explicit `worktree.quarantine` recoverable action
- Git recovery refs
- same-filesystem quarantine with durable recovery manifests
- `agentrinse undo`
- `agentrinse purge`
- interrupted-quarantine inspection and deterministic recovery instructions
- Git worktree prune/repair integration through Git commands
- expiry policy that never removes live recovery metadata
- Homebrew formula in `vincentkoc/tap`
- Homebrew install, audit, plan, quarantine, undo, and upgrade smoke proof

Exit criteria:

- dirty, active, pinned, locked, unpushed, and detached-risk fixtures are never
  selected
- quarantine and undo pass across supported macOS filesystems and packaged
  Linux proof
- interrupted cleanup has deterministic recovery instructions
- recovery is exercised from the packed artifact
- Homebrew installs the exact released version and passes its formula test
- no Docker mutation or provider-state deletion is introduced

### `0.4.0`: owner-managed maintenance

Deliver:

- explicit offline Codex log compaction
- old agent runtime removal
- a decision and proof for labeled stopped-container cleanup; keep it
  report-only if reliable recreation cannot be demonstrated
- filtered Docker build-cache cleanup only after current owner-contract proof

Exit criteria:

- database compaction retains verified rollback
- active provider processes block mutation
- exact Docker context and object identity are revalidated before mutation

### `1.0.0`: stable contracts

Deliver:

- stable machine contracts
- migration support for compatible old plans/run records
- performance budgets
- security review
- complete docs
- npm and Homebrew long-term release support

Exit criteria:

- zero unresolved high-severity safety findings
- no known false-positive destructive cleanup
- stable adapter capability matrix
- end-to-end install, audit, plan, apply, undo, and purge proof

## Acceptance Criteria

### Audit

- Finds Git worktrees under configured and provider-managed roots.
- Identifies the main worktree.
- Distinguishes clean, dirty, staged, untracked, locked, detached, and
  in-progress states.
- Identifies live process CWD ownership.
- Links supported Codex and Claude sessions to worktrees without reading
  transcript contents.
- Inventories Cursor, GitHub Copilot, Zed, OpenCode, and Grok Build state
  without treating their session stores as disposable.
- Detects OpenCode snapshot growth and recursive capture risk.
- Reports provider retention settings and native cleanup expectations.
- Reports database free-page opportunities without mutating databases.
- Reports Docker context and graceful daemon unavailability.
- Produces valid JSON and NDJSON.
- Produces a redacted report safe for bug filing.

### Planning

- Produces deterministic actions for unchanged inputs.
- Persists config, audit, policy, and action digests.
- Never includes actions above the requested risk ceiling.
- Explains every excluded protected resource.
- Rejects cycles and unknown action types.

### Apply

- Requires explicit authorization.
- Acquires durable locks.
- Revalidates every action.
- Skips changed resources.
- Records every state transition.
- Survives SIGINT without losing run truth.
- Never expands the planned resource set.

### Git cleanup

- Never removes the main worktree.
- Never removes dirty, active, locked, provider-rooted, or unpushed work.
- Trims only declared rebuildable artifacts.
- Quarantines eligible worktrees on the same filesystem.
- Creates a durable recovery ref before removal.
- Restores a quarantined worktree without overwriting new paths.

### Docker cleanup

- Never removes running containers.
- Never removes referenced images.
- Never mutates volumes by default.
- Uses exact IDs or reviewed filters.
- Detects context changes before apply.

### Provider maintenance

- Never deletes transcripts in 1.0.
- Blocks compaction while any owner process or descriptor is active.
- Verifies source and compacted database integrity.
- Preserves a rollback copy until expiry.

### Packaging

- Installs through npm on supported Node versions.
- `npx agentrinse audit` works from a clean environment.
- Package contains only intended files.
- Provenance is visible on npm.
- Release does not require a long-lived npm token.

## Default Policy Table

| Resource                       | Default age | Action               | Risk        | Recovery        |
| ------------------------------ | ----------: | -------------------- | ----------- | --------------- |
| active worktree                |         any | none                 | n/a         | protected       |
| dirty worktree                 |         any | none                 | n/a         | protected       |
| unpushed worktree              |         any | none                 | n/a         | protected       |
| locked worktree                |         any | none                 | n/a         | protected       |
| inactive worktree artifacts    |          3d | remove artifacts     | safe        | rebuild         |
| clean unreachable worktree     |         14d | quarantine           | recoverable | 7d undo         |
| Codex/Claude sessions          |         any | report only          | n/a         | provider-owned  |
| Cursor workspace/global state  |         any | report only          | n/a         | editor-owned    |
| GitHub Copilot sessions        |         any | report only          | n/a         | provider-owned  |
| Zed database/agent state       |         any | report only          | n/a         | editor-owned    |
| OpenCode database/snapshots    |         any | report only          | n/a         | provider-owned  |
| Grok Build sessions/task state |         any | report only          | n/a         | provider-owned  |
| Codex logs DB free pages       |   threshold | report only          | n/a         | phase 4         |
| dangling Docker image          |         14d | remove exact image   | safe        | rebuild/pull    |
| Docker build cache             |          7d | filtered prune       | safe        | rebuild         |
| unlabeled stopped container    |         any | report only          | n/a         | owner decision  |
| labeled stopped container      |         14d | report only          | n/a         | future design   |
| Docker network                 |         14d | narrow removal       | safe        | recreate        |
| Docker volume                  |         any | report only          | n/a         | protected       |
| old agent runtime              |         14d | report, later remove | safe        | package manager |
| Mole cleanup                   |         any | handoff              | external    | Mole-owned      |

Defaults are intentionally conservative. Power comes from good root discovery,
not aggressive age thresholds.

## Metrics

No telemetry is sent.

Local run summaries may calculate:

- discovered bytes by adapter
- eligible bytes by risk class
- immediate bytes reclaimed
- bytes moved to quarantine
- protected-resource counts by root reason
- skipped-stale action count
- action failure count
- audit and apply duration

Product-quality metrics gathered through opt-in issue reports:

- false-positive cleanup incidents: target zero
- percentage of findings with a concrete reason
- undo success rate
- median time to first finding
- adapter degradation frequency
- divergence between estimated and observed reclaimed bytes

## Risks and Tradeoffs

### Provider schema drift

Risk: provider internals change.

Mitigation:

- support exact known versions/layouts
- feature probes
- fail closed
- contract fixtures
- keep mutations provider-native or explicitly offline

### Worktree recovery complexity

Risk: Git administrative state and moved filesystem state diverge.

Mitigation:

- recovery ref first
- same-filesystem quarantine
- documented Git repair commands
- exhaustive integration fixtures
- no rollout until undo is proven

### Quarantine delays reclamation

Risk: large worktrees remain on disk for seven days.

Decision: accept this for recoverable cleanup. Rebuildable artifact removal
provides immediate reclamation. Immediate worktree purge remains separate and
destructive.

### Conservative defaults reclaim less

Risk: the tool appears weaker than broad cleaners.

Decision: safety is the product. AgentRinse should be better at proving dead
state, not better at issuing recursive deletes.

### npm and Node are not universal

Risk: users without Node cannot use the package.

Decision: npm is the requested primary distribution and matches the existing
personal package workflow. Homebrew and release archives follow after contract
stability.

### External command behavior changes

Risk: Git, Docker, provider, or Mole output changes.

Mitigation:

- structured formats
- capability/version probes
- exact argv invocation
- stable owner APIs
- no scraping decorative output

### Size measurement cost

Risk: recursive measurement makes audits slow.

Mitigation:

- stream findings
- known roots only
- cache safe measurements
- allow fast and deep modes
- show unknown size rather than block classification

## Open Questions

These do not block the Phase 0 scaffold but need decisions before their phase.

1. Should the Git scan root default include only current/provider roots, or
   conventional directories such as `$HOME/src`, `$HOME/GIT`, and
   `$HOME/Projects`?
   - Decision: current/provider roots by default; conventional roots only
     through generated config. Avoid surprising whole-home scans.
2. Should clean worktree quarantine default to 7 days or 3 days?
   - Recommendation: 7 days until field confidence is high.
3. Should recent session protection be count-based, age-based, or both?
   - Recommendation: protect if either the most recent 50 or newer than 30
     days.
4. Should `clean --apply --yes` include recoverable worktrees?
   - Recommendation: default automation ceiling `safe`; require explicit
     `--max-risk recoverable`.
5. Should Docker stopped-container removal be classified recoverable?
   - Decision for 0.x: report-only. A later action is destructive unless
     AgentRinse can produce and validate a complete recreation descriptor.
6. Should offline Codex database compaction ship before 1.0?
   - Recommendation: yes, as explicit experimental functionality only after
     upstream schema and process-lock tests exist.
7. Should the package expose a public library API?
   - Recommendation: no stability promise before 1.0. Build internal seams,
     then expose only proven contracts.
8. Should AgentRinse install a scheduler?
   - Recommendation: no. Generate documented launchd/systemd examples after
     the CLI is stable, but never silently install one.

## Initial Decision Log

### 2026-07-23: choose AgentRinse

Use `AgentRinse`, `agentrinse`, and `agentrinse.com`.

### 2026-07-23: local-first CLI

No cloud service, account, telemetry, or daemon is required.

### 2026-07-23: garbage-collection model

Reachability roots, not age alone, determine safety.

### 2026-07-23: dry by default

`audit`, `plan`, and `clean` do not mutate without explicit apply.

### 2026-07-23: no generic force

Overrides must name the exact policy. Hard invariants remain non-overridable.

### 2026-07-23: provider session deletion excluded

Codex and Claude session cleanup stays provider-owned through 1.0.

### 2026-07-23: Docker volumes excluded

Volumes are report-only through 1.0.

### 2026-07-23: Mole as external handoff

AgentRinse remains MIT and does not incorporate Mole's GPL implementation.

### 2026-07-23: atomic JSON state

Plans and runs are named artifacts, stored as owner-only atomic JSON in the
MVP. A database is not justified yet.

### 2026-07-23: macOS first

macOS is Tier 1. Linux is Tier 2 from `0.1.0` after packaged proof. Native
Windows mutation remains blocked before 1.0.

### 2026-07-24: staged public release sequence

Publish `0.0.0` only to reserve the npm name and configure trusted publishing.
The first supported release is `0.1.0`. Release `0.2.0` adds agent-aware
reachability without expanding mutation. Release `0.3.0` adds recoverable
worktree quarantine and undo.

### 2026-07-24: operational UX precedes mutation growth

Configuration generation, doctor diagnostics, run inspection, stale-lock
handling, partial-run recovery guidance, and real dogfood are required before
the supported `0.1.0` release. More cleanup targets are not a substitute for a
safe operator loop.

### 2026-07-24: Homebrew by 0.3.0

The supported npm release remains the first distribution target. A formula in
`vincentkoc/tap` and install/upgrade proof are required before `0.3.0`.

### 2026-07-24: recoverable worktree mutation boundary

`0.3.0` adds exactly one new mutating action: `worktree.quarantine`.

- Eligibility requires a linked, unlocked, clean, terminal worktree with
  complete filesystem measurement, no ignored files, no status-suppressed
  index entries, no submodules, no live ownership, no reachability root, no
  detached state, no unpushed commit, and at least 14 days since the newest
  measured worktree entry. A worktree named `.agentrinse-quarantine` is
  protected because that sibling name is reserved for the quarantine
  container, and the container itself must not be a registered worktree.
- The action is `recoverable` and is excluded by the default `safe` risk
  ceiling. Automation must explicitly select `--max-risk recoverable`.
- Quarantine uses an atomic rename into an owner-only
  `.agentrinse-quarantine/<entry-id>` directory beside the original worktree.
  Cross-device copy-and-delete fallback is forbidden.
- A recovery ref is created before the rename. The moved worktree is repaired
  through `git worktree repair`, retained as a locked registered worktree, and
  recorded in an owner-only quarantine manifest.
- Undo reconciles durable `preparing`, `recovery-ref-created`, and `moved`
  manifests by inspecting both paths, repairing the actual registration, and
  preserving or recreating only the exact namespaced recovery ref.
- Undo reconciles `partial` quarantine manifests only when exactly one known
  original, quarantine, or purge-isolation path exists and passes full
  identity, content, registration, lock, process, mount, and ref validation.
- Mutation verifies the exact `AgentRinse quarantine <entry-id>` lock reason.
  A foreign or operator-owned Git worktree lock is immutable protection and
  is checked before any `git worktree repair`. The registration must also be
  at an exact old or new path owned by the current transition.
- Undo, rollback, and purge never call Git's unconditional worktree unlock.
  AgentRinse atomically captures the administrative lock file, verifies its
  exact ownership reason after capture, restores a foreign replacement, and
  retains a released owned lock as a small proof marker. An interrupted claim
  is restored before later validation.
- Git operation markers are re-read immediately before every quarantine,
  undo, and purge mutation; clean status alone is not terminal-state proof.
- Undo conditionally releases its owned lock, atomically renames, repairs,
  verifies, and only then deletes the exact recovery ref. It never overwrites
  an occupied destination.
- Purge is a separate destructive command. It conditionally releases its owned
  lock, atomically renames to a deterministic same-filesystem isolation path,
  repairs and repeats full validation there, then invokes clean
  `git worktree remove` without
  `--force`; changed or unclean quarantine state is refused and an interrupted
  isolation failure is rolled back to locked quarantine. Finalization refuses
  a matching branch and HEAD registration at any unexpected path.
- Before each destructive purge, AgentRinse reloads configuration and provider
  workspace metadata under the mutation lock. It rechecks the recorded resource
  ID, Git ref, original path, quarantine path, and deterministic purge-isolation
  path against all current reachability roots. A matching pin, provider-managed
  root, active/recent session, or unknown provider state refuses permanent
  removal. The purge state machine repeats this refresh immediately before each
  normal or resumed `git worktree remove`.
- Quarantine reports zero immediately reclaimed bytes and records the full
  byte count as pending expiry. The default undo TTL is seven days.
- macOS and Linux are supported. Native Windows worktree mutation remains
  blocked until atomic rename and ownership proof are independently proven.

This owner-command sequence was validated on July 24, 2026 against Git 2.54.0
using a disposable repository, including quarantine repair, lock, undo repair,
exact recovery-ref deletion, and clean purge.

## Specification Maintenance

### Ownership

The AgentRinse maintainer owns this specification and the public contracts it
defines.

Adapter-specific sections should name code owners once the repository exists:

- core safety and plan/apply contracts
- Git adapter
- Codex adapter
- Claude adapter
- Docker adapter
- packaging and release

### Refresh triggers

Review the affected section when any of these occurs:

- Codex changes session, archive, log database, or managed-worktree behavior
- Claude changes `cleanupPeriodDays`, session storage, or worktree behavior
- Cursor changes workspace/global storage or chat/session behavior
- GitHub Copilot CLI changes its config directory, session, log, or sync
  contracts
- Zed changes its user-data, agent-thread, or ACP log storage
- OpenCode changes database, session, snapshot, or owner cleanup behavior
- Grok Build changes `GROK_HOME`, local storage, ACP, or task lifecycle
- Git changes worktree porcelain or repair semantics
- Docker changes prune filters or object-reference behavior
- Mole adds a stable machine-readable cleanup contract or changes licensing
- Node.js minimum support or SQLite capabilities change
- a real cleanup incident, false positive, failed undo, or partial run occurs
- a JSON schema or action contract changes
- a new platform becomes supported

### Stale criteria

The research snapshot is stale after 90 days or any known upstream lifecycle
change, whichever comes first.

The normative safety invariants do not expire. If current upstream behavior
cannot be reverified, the affected adapter must degrade to audit-only or
unsupported.

### Review cadence

- refresh dependency/provider evidence before each minor release
- rerun destructive fixture proof before every release containing mutation
- review all defaults before 1.0
- perform a full threat-model and recovery review at least annually after 1.0

### Change discipline

Changes to normative machine contracts require:

1. updated TypeScript contract
2. updated JSON Schema
3. compatibility classification
4. fixtures for old and new forms where compatibility is supported
5. documentation and changelog entry
6. packed-artifact smoke proof

Changes to safety invariants require explicit maintainer approval and a written
decision-log entry. They must not be smuggled in as adapter fixes.

## Implementation Checklist

### Repository

- [ ] register `agentrinse.com` and publish documentation
- [x] reserve npm package with `0.0.0`
- [x] create public repository
- [x] add MIT license
- [x] configure pnpm and Node 22
- [x] add TypeScript ESM build
- [x] add Vitest, oxfmt, oxlint, and publint
- [x] add package artifact smoke
- [x] configure and prove npm trusted publishing
- [x] add security policy and contribution guide
- [ ] protect `main` with required CI
- [ ] protect the GitHub `npm` release environment

### Contracts

- [x] define config schema
- [x] define resource/finding schema
- [x] define plan/run schema
- [x] define diagnostic codes
- [x] define initial exit codes
- [x] implement canonical JSON hashing
- [x] implement initial schema compatibility tests
- [x] define `0.2.0` reachability facts and roots
- [x] define `0.3.0` quarantine, recovery, undo, and purge records

### Core safety

- [x] implement path guards
- [x] implement process ownership proof
- [x] implement global apply lock
- [x] implement atomic run journal
- [x] implement artifact revalidation and isolation
- [x] implement command cancellation and interrupted-run reporting
- [x] implement redacted export
- [x] keep destructive tests inside synthetic temporary roots
- [x] add explicit runtime destructive-test root guard
- [x] add stale-lock inspection and owned recovery
- [x] add partial-run recovery inspection

### Adapters

- [x] initial report-only Git worktree audit
- [x] process ownership
- [x] initial Codex inventory
- [x] initial Claude inventory
- [x] initial Docker inventory
- [x] Cursor, Copilot CLI, Zed, OpenCode, and Grok inventory
- [x] runtime audit
- [x] Mole probe
- [x] exact configured artifact removal
- [x] Git dirty, staged, untracked, operation, detached, and push-state proof
- [x] Codex and Claude session-to-worktree roots
- [x] provider-managed worktree and pin roots
- [ ] Docker safe cleanup
- [x] worktree quarantine
- [x] worktree undo
- [ ] offline database compaction

### Documentation and release

- [x] safety guide
- [x] automation guide
- [x] recovery guide
- [x] adapter capability matrix
- [x] config reference
- [ ] website docs
- [ ] npm provenance proof
- [ ] Homebrew formula
- [ ] real workstation read-only audit proof
- [ ] disposable real-project apply canary
- [ ] npm and `npx` install smoke
- [ ] Homebrew install and upgrade smoke
- [ ] 1.0 security review

## Reference Links

Primary references current as of 2026-07-23:

- Codex worktrees:
  `https://developers.openai.com/codex/environments/git-worktrees`
- Codex source:
  `https://github.com/openai/codex`
- Claude Code settings:
  `https://docs.anthropic.com/en/docs/claude-code/settings`
- Cursor documentation:
  `https://cursor.com/docs`
- GitHub Copilot CLI configuration directory:
  `https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference`
- GitHub Copilot CLI session data:
  `https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle`
- Zed CLI and user-data directory:
  `https://zed.dev/docs/reference/cli`
- OpenCode troubleshooting and storage:
  `https://opencode.ai/docs/troubleshooting/`
- OpenCode CLI:
  `https://opencode.ai/docs/cli/`
- Grok Build:
  `https://docs.x.ai/build/overview`
- Grok Build settings:
  `https://docs.x.ai/build/settings`
- Grok Build source:
  `https://github.com/xai-org/grok-build`
- Git worktree documentation:
  `https://git-scm.com/docs/git-worktree`
- Docker system prune:
  `https://docs.docker.com/reference/cli/docker/system/prune/`
- Docker image prune:
  `https://docs.docker.com/reference/cli/docker/image/prune/`
- Docker container prune:
  `https://docs.docker.com/reference/cli/docker/container/prune/`
- Docker volume prune:
  `https://docs.docker.com/reference/cli/docker/volume/prune/`
- Docker buildx prune:
  `https://docs.docker.com/reference/cli/docker/buildx/prune/`
- Mole:
  `https://github.com/tw93/Mole`
- npm provenance:
  `https://docs.npmjs.com/generating-provenance-statements/`

## Final Product Standard

AgentRinse is ready when a developer can let it inspect a machine full of
valuable unfinished agent work and trust two things:

1. it will clearly identify meaningful space that can be reclaimed
2. it will refuse to clean anything whose ownership or recovery is uncertain

That refusal is not a limitation. It is the product.
