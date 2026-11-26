import { lstat, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import type { AuditContext, CollectionObserver } from "../contracts/adapter.js";
import type { ResourceKind, ResourceSnapshot } from "../contracts/resource.js";
import { sha256 } from "../core/digest.js";
import { measurePath } from "../core/measure.js";
import { inspectProviderFile } from "../core/provider-file-identity.js";
import { OPENCLAW_SHELL_SNAPSHOT_POLICY } from "../core/provider-file-policy.js";
import type { ReachabilityIndex } from "../core/reachability.js";
import { inspectOpenClawDatabase, type OpenClawWorktree } from "./openclaw-database.js";
import { openClawOwnership } from "./openclaw-ownership.js";

const surfaces = {
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

type Surface = keyof typeof surfaces;
type Options = {
  measureBytes: boolean;
  maxEntries: number;
  inventoryResources?: boolean;
  reachability?: ReachabilityIndex;
  environment?: NodeJS.ProcessEnv;
};
type Facts = Record<string, unknown>;
const sessionPreview = "openclaw sessions cleanup --all-agents --dry-run --json";
const day = 24 * 60 * 60 * 1000;

function worktreeFacts(record: OpenClawWorktree) {
  return {
    source: "worktrees",
    ownerKind: record.owner,
    repositoryRoot: record.repoRoot,
    removed: record.removed,
    hasSnapshot: record.hasSnapshot,
    ownerInventory: "openclaw worktrees list --json",
  };
}

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

export async function collectOpenClaw(
  context: AuditContext,
  root: string,
  options: Options,
  observer: CollectionObserver,
) {
  if (!(await lstat(root)).isDirectory()) throw new Error("OpenClaw root changed during discovery");
  const physical = await realpath(root);
  const owner = await openClawOwnership(
    physical,
    context.home,
    options.environment ?? {},
    options.maxEntries,
    options.reachability,
  );
  if (options.inventoryResources === false) return;
  const records = owner.registry.status === "observed" ? owner.registry.worktrees : [];
  const activePaths = new Map(
    records.filter((record) => !record.removed).map((record) => [record.path, record]),
  );
  const reportedRecords = new Set<string>();
  let sessionBudget = Math.max(0, options.maxEntries - records.length);
  let remaining = options.maxEntries;
  let measurementEntries = options.maxEntries;
  const observedAt = context.now.toISOString();
  const diagnostic = (code: string, message: string) =>
    observer.reportDiagnostic({ severity: "warning", adapter: "openclaw", code, message });
  const emit = (
    path: string,
    surface: Surface,
    facts: Facts,
    bytes?: number,
    key = surface as string,
  ) => {
    const [kind, label] = surfaces[surface];
    const canonicalKey = `openclaw:${key}:${path}`;
    observer.reportResource({
      resource: {
        id: `openclaw:${kind}:${sha256(canonicalKey)}`,
        adapter: "openclaw",
        kind,
        canonicalKey,
        displayName: `OpenClaw ${label}`,
        path,
      },
      observedAt,
      exists: true,
      facts: { reportOnly: true, openClawSurface: surface, ...facts },
      ...(bytes === undefined ? {} : { measuredBytes: bytes }),
    });
  };
  async function scan(path: string, visit: (child: string, directory: boolean) => Promise<void>) {
    if (remaining <= 0) {
      remaining = -1;
      return;
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || (await realpath(path)) !== path) {
      diagnostic("OPENCLAW_UNSAFE_DIRECTORY", "A changed or indirect directory was skipped.");
      return;
    }
    const dir = await opendir(path);
    for await (const entry of dir) {
      context.signal?.throwIfAborted();
      if (remaining-- <= 0) break;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostic("RESOURCE_SYMLINK_SKIPPED", "An OpenClaw resource symlink was skipped.");
      } else if (entry.isFile() || entry.isDirectory()) {
        try {
          await visit(child, entry.isDirectory());
        } catch (error) {
          context.signal?.throwIfAborted();
          diagnostic(
            "OPENCLAW_INSPECTION_INCOMPLETE",
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "An entry disappeared during inventory."
              : "An entry could not be inspected safely.",
          );
        }
      }
    }
  }
  async function report(
    path: string,
    surface: Surface,
    facts: Facts = {},
    excludeRootEntries?: string[],
  ) {
    if ((await realpath(path)) !== path) {
      diagnostic("RESOURCE_SYMLINK_SKIPPED", "An indirect OpenClaw resource was skipped.");
      return;
    }
    const measured =
      options.measureBytes && measurementEntries > 0
        ? await measurePath(path, {
            maxEntries: measurementEntries,
            ...(excludeRootEntries ? { excludeRootEntries } : {}),
            ...(context.signal ? { signal: context.signal } : {}),
          })
        : undefined;
    measurementEntries -= measured?.entries ?? 0;
    emit(
      path,
      surface,
      {
        ...facts,
        ...(measured
          ? {
              entries: measured.entries,
              symlinksSkipped: measured.symlinksSkipped,
              measurementTruncated: measured.truncated,
            }
          : {}),
      },
      measured?.bytes,
    );
  }
  async function database(path: string, role: "agent" | "global") {
    const inspection = !owner.config.complete
      ? { status: "owner-unresolved" as const }
      : role === "global"
        ? owner.registry
        : await inspectOpenClawDatabase(path, role, sessionBudget);
    await report(path, role === "global" ? "sharedDatabase" : "agentDatabase", {
      databaseStatus: inspection.status,
      ...(role === "agent"
        ? { maintenancePreview: sessionPreview }
        : { ownerInventory: "openclaw worktrees list --json" }),
      ...(inspection.status === "observed"
        ? {
            schemaVersion: inspection.schemaVersion,
            counts: inspection.counts,
            countsTruncated: inspection.truncated,
          }
        : {}),
    });
    if (role === "agent" && inspection.status === "observed") {
      sessionBudget -= inspection.sessions.length;
      for (const { id, archived, pinned, running } of inspection.sessions) {
        emit(
          path,
          "session",
          { source: "session_nodes", archived, pinned, running, referenceOnly: true },
          undefined,
          "session-" + id,
        );
      }
    }
  }
  async function agent(path: string, isDirectory: boolean) {
    if (!isDirectory) return report(path, "provider");
    await scan(path, async (child, dir) => {
      const name = basename(child);
      if (name === "sessions" && dir) {
        return scan(child, (file) => {
          const name = basename(file);
          const format =
            name === "sessions.json"
              ? "legacy-index"
              : name.endsWith(".jsonl")
                ? "transcript"
                : /\.jsonl\.(?:reset|deleted)\./u.test(name)
                  ? "archived-transcript"
                  : "session-artifact";
          return report(file, "sessions", { format, maintenancePreview: sessionPreview });
        });
      }
      if (name !== "agent" || !dir) return report(child, "provider");
      await scan(child, (file, directory) => {
        const leaf = basename(file);
        if (leaf === "openclaw-agent.sqlite" && !directory) return database(file, "agent");
        if (leaf.startsWith("openclaw-agent.sqlite")) return report(file, "recovery");
        return report(file, /^(auth|credentials)/u.test(leaf) ? "credentials" : "provider");
      });
    });
  }
  async function cache(path: string, dir: boolean) {
    if (basename(path) !== "shell-snapshots" || !dir) return report(path, "cache");
    await scan(path, async (child, directory) => {
      if (
        directory ||
        !OPENCLAW_SHELL_SNAPSHOT_POLICY.matchesRelativePath(relative(physical, child))
      )
        return report(child, "cache");
      const stats = await lstat(child);
      const ageDays = (context.now.getTime() - stats.mtimeMs) / day;
      const facts: Facts = { nativeSweepDays: 3, olderThanNativeRetention: ageDays > 3 };
      if (
        ageDays >= OPENCLAW_SHELL_SNAPSHOT_POLICY.minAgeMinutes / 1440 &&
        ["darwin", "linux"].includes(process.platform)
      ) {
        if (owner.registry.status === "uncheckpointed") {
          facts.identityStatus = "uncheckpointed";
        } else {
          try {
            const identity = await inspectProviderFile(
              child,
              physical,
              "openclaw",
              OPENCLAW_SHELL_SNAPSHOT_POLICY.contentPrefix,
            );
            Object.assign(facts, {
              reportOnly: false,
              policyId: OPENCLAW_SHELL_SNAPSHOT_POLICY.id,
              providerFileIdentity: identity,
              maintenanceAction: "provider.file-quarantine",
            });
          } catch {
            facts.identityStatus = "unverified";
          }
        }
      }
      await report(child, "snapshot", facts);
    });
  }
  async function log(path: string, directory: boolean, fallback = false) {
    const match = /^openclaw-(?:[a-z0-9-]+-)?\d{4}-\d{2}-\d{2}(?:\.([1-5]))?\.log$/u.exec(
      basename(path),
    );
    if (!match || directory) return report(path, fallback ? "provider" : "logs");
    const stat = await lstat(path);
    return report(path, "dailyLog", {
      rotated: match[1] !== undefined,
      olderThanNativeRetention: context.now.getTime() - stat.mtimeMs > day,
      nativeRollingRetentionHours: 24,
    });
  }
  async function workspace(path: string) {
    await report(path, "workspace", {}, ["MEMORY.md", "memory"]);
    for (const name of ["MEMORY.md", "memory"]) {
      const child = join(path, name);
      try {
        await report(child, "memory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  async function worktreeBucket(path: string, directory: boolean) {
    if (directory && basename(path) === ".templates") return report(path, "template");
    if (!directory || !/^[0-9a-f]{16}$/u.test(basename(path)))
      return report(path, "worktreeStorage");
    await scan(path, async (checkout, dir) => {
      if (!dir || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(basename(checkout)))
        return report(checkout, "worktreeStorage");
      const record = activePaths.get(checkout);
      await report(
        checkout,
        "worktree",
        record
          ? worktreeFacts(record)
          : {
              source: "checkout-layout",
              registryStatus: owner.registry.status,
              ownerKind: "unverified",
            },
      );
      if (record) reportedRecords.add(record.id);
    });
  }
  const roots: Record<string, Surface> = {
    credentials: "credentials",
    identity: "credentials",
    devices: "credentials",
    media: "media",
    "delivery-queue-media": "media",
    memory: "memory",
    worktrees: "worktreeStorage",
    models: "provider",
    skills: "provider",
    extensions: "provider",
    plugins: "provider",
    sandboxes: "workspace",
  };
  await scan(physical, async (path, directory) => {
    const name = basename(path);
    if (directory) {
      if (name === "agents") return scan(path, agent);
      if (name === "worktrees") return scan(path, worktreeBucket);
      if (name === "logs") return scan(path, log);
      if (name === "tmp") {
        return scan(path, (child, dir) =>
          dir && /^openclaw(?:-\d+)?$/u.test(basename(child))
            ? scan(child, (file, directory) => log(file, directory, true))
            : report(child, "provider"),
        );
      }
      if (name === "cache") return scan(path, cache);
      if (name === "workspace" || name.startsWith("workspace-")) return workspace(path);
      if (name === "state")
        return scan(path, (file, dir) =>
          basename(file) === "openclaw.sqlite" && !dir
            ? database(file, "global")
            : report(file, "recovery"),
        );
      if (name === "client") return scan(path, (file) => report(file, "credentials"));
      if (name === "control") return scan(path, (file) => report(file, "recovery"));
    }
    if (name === "openclaw.json")
      return report(path, "configuration", { ownerPathsComplete: owner.config.complete });
    if (name.startsWith("openclaw.json.bak")) return report(path, "configuration");
    return report(path, Object.hasOwn(roots, name) ? roots[name]! : "provider");
  });
  // Registry paths can point outside this profile or at removed checkouts.
  // Publish the owner's record without walking a path supplied by the database.
  for (const record of records) {
    if (!reportedRecords.has(record.id)) {
      emit(
        record.path,
        "worktree",
        { ...worktreeFacts(record), referenceOnly: true },
        undefined,
        "registered-worktree-" + sha256(record.id),
      );
    }
  }
  for (const [path, surface] of owner.config.paths) {
    const rel = relative(physical, path);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      emit(
        path,
        surface,
        { source: "configured-owner-path", referenceOnly: true },
        undefined,
        "configured-path",
      );
    }
  }
  if (remaining < 0)
    diagnostic("OPENCLAW_ENTRY_LIMIT", "OpenClaw discovery reached the configured entry limit.");
}
