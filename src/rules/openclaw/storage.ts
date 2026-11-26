import type { ResourceKind, ResourceSnapshot } from "../../contracts/resource.js";

export const surfaces = {
  session: [
    "agent-session-store",
    "Stored session",
    "A durable OpenClaw session can be resumed, referenced or restored. Its lifecycle and transcript generations belong to the session owner.",
  ],
  sessions: [
    "agent-session-store",
    "Session storage",
    "Session indexes, replay transcripts and archived migration inputs are needed for history and recovery.",
  ],
  agentDatabase: [
    "agent-database",
    "Agent database",
    "Session history, memory indexes, embedding cache and authentication records share this database. Removing or vacuuming it requires the owner's storage protocol.",
  ],
  sharedDatabase: [
    "agent-database",
    "Shared state database",
    "The shared registry holds worktree ownership, recovery records, approvals and configuration state.",
  ],
  recovery: [
    "agent-database",
    "Database recovery state",
    "Recovery stores, seals and SQLite sidecars belong to the database owner.",
  ],
  workspace: [
    "agent-home",
    "Agent workspace",
    "Workspace files can be user-authored or belong to active and resumable agents.",
  ],
  memory: [
    "agent-home",
    "Agent memory",
    "Memory documents and indexes hold durable knowledge; only the owner can determine which entries to forget.",
  ],
  credentials: [
    "agent-home",
    "Authentication and identity",
    "Private identities, credential stores and pairing records can authorize active clients.",
  ],
  configuration: [
    "agent-home",
    "Profile configuration",
    "Configuration and backups are required to run or recover the profile.",
  ],
  worktree: [
    "git-worktree",
    "Managed worktree",
    "OpenClaw owns checkout activity, snapshot refs and restoration. Git cleanliness alone cannot establish disposability.",
  ],
  worktreeStorage: [
    "agent-snapshot-store",
    "Worktree storage",
    "Checkout data and preparation templates share this storage. OpenClaw coordinates allocation, snapshots and garbage collection.",
  ],
  template: [
    "agent-cache",
    "Worktree preparation templates",
    "OpenClaw can reuse these checkout generations and coordinates their creation and retirement. An apparently idle template may be shared by other preparations.",
  ],
  dailyLog: [
    "agent-log-store",
    "Gateway rolling log",
    "OpenClaw rotates its default logs and prunes old files in rolling mode. A custom logging.file can select a different active file or retention mode.",
  ],
  logs: [
    "agent-log-store",
    "Diagnostic or audit log",
    "Custom logs and configuration audit trails have no proven rolling-log retention contract.",
  ],
  snapshot: [
    "agent-cache",
    "Exec shell snapshot",
    "A running exec can still source the capture. Quarantine requires a verified generated file, a 30-day minimum age and idle ownership at apply.",
  ],
  cache: [
    "agent-cache",
    "Provider cache",
    "Other cache entries and in-progress captures have no verified standalone disposal contract.",
  ],
  media: [
    "agent-home",
    "Media and pending delivery",
    "Attachments may still be referenced by history or queued for delivery. OpenClaw checks provenance and retention.",
  ],
  provider: [
    "agent-home",
    "Provider state",
    "OpenClaw owns installed components, user assets and unrecognized state. Independent removal has no verified recovery contract.",
  ],
} as const satisfies Record<string, readonly [ResourceKind, string, string]>;

export type Surface = keyof typeof surfaces;
export function openClawProtection(resource: ResourceSnapshot) {
  const surface = resource.facts.openClawSurface;
  if (typeof surface !== "string" || !Object.hasOwn(surfaces, surface)) return undefined;
  let detail: string = surfaces[surface as Surface][2];
  if (surface === "session") {
    if (resource.facts.running) detail += " The stored session status is running.";
    if (resource.facts.pinned) detail += " The session is pinned.";
    if (resource.facts.archived) detail += " Archiving preserves the session and its history.";
  }
  const status = resource.facts.databaseStatus;
  if (status === "uncheckpointed")
    detail +=
      " A WAL or rollback journal may hold newer rows, so row counts and registry records are withheld.";
  if (status === "unsupported" || status === "unreadable" || status === "changed")
    detail += " A stable supported database schema could not be verified.";
  if (status === "owner-unresolved")
    detail += " The local SQLite file could not be bound to the configured owner.";
  if (resource.facts.identityStatus === "unverified")
    detail +=
      " The generated header, single-link identity or stable contents could not be verified.";
  if (resource.facts.identityStatus === "uncheckpointed")
    detail +=
      " The shared database has an outstanding journal; owner activity cannot be ruled out.";
  if (resource.facts.ownerPathsComplete === false)
    detail +=
      "Configured locations could not be completely resolved without evaluating external or nonliteral configuration.";
  return { code: `openclaw-${surface.replace(/[A-Z]/gu, (c) => "-" + c.toLowerCase())}`, detail };
}
