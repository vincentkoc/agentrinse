import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import { redactAuditValue } from "../core/redaction.js";
import { isPathInside } from "../core/safety.js";
import { readStorageMounts, type StorageMount } from "../core/storage-mounts.js";
import { directStorageEntries, observeStoragePath } from "../core/storage-observation.js";
import {
  discoverOwner,
  observeInventorySections,
  compareInventorySections,
  recheckOwner,
} from "../rules/git/inventory-owner.js";
import { protectedStorageName } from "../core/storage-measurement.js";
import { gitObjectFormat, inventoryLooseObjects } from "../rules/git/inventory-loose.js";
import { inventoryPath } from "../rules/git/inventory-path.js";
import { GitIdentityLedger } from "../rules/git/inventory-bytes.js";
import { inventoryPackStore } from "../rules/git/inventory-packs.js";
import {
  inventoryRegistrations,
  type ReviewRegistrations,
} from "../rules/git/inventory-registrations.js";
import { gitLifecycleInput } from "../rules/git/inventory-lifecycle.js";

export type GitInventoryOptions = {
  home: string;
  repo: string[];
  repoRoot: string[];
  worktreeRoot: string[];
  maxEntries?: string;
  gwtStatusStdin?: boolean;
  looseObjects?: boolean;
  redact?: boolean;
  json?: boolean;
};
type Dependencies = {
  mounts?: () => Promise<StorageMount[] | undefined>;
  input?: AsyncIterable<Uint8Array>;
  environment?: NodeJS.ProcessEnv;
};
type Repository = {
  path: string;
  coverage: string;
  commonDirectory?: string;
  commonMetadataChanged?: boolean;
  changedSections?: string[];
  uniqueWithinOwner?: ReturnType<GitIdentityLedger["report"]>;
  packs?: Awaited<ReturnType<typeof inventoryPackStore>>;
  looseObjects?: Awaited<ReturnType<typeof inventoryLooseObjects>>["report"];
  worktrees?: Awaited<ReturnType<typeof inventoryRegistrations>>;
};
const maxOwners = 8192;
function literal(p: string) {
  if (!isAbsolute(p) || /[\0\r\n]/u.test(p))
    throw new Error("Git inventory requires absolute literal paths");
  return resolve(p);
}
function repoPath(value: string, home: string) {
  const p = literal(value);
  if (dirname(p) === p || isPathInside(p, home) || p.split(sep).some(protectedStorageName))
    throw new Error("Select a specific durable owner or its direct parent outside protected data");
  return p;
}
export async function inventoryGitOwners(options: GitInventoryOptions, deps: Dependencies = {}) {
  const startedAt = new Date().toISOString(),
    home = literal(options.home);
  const max = options.maxEntries ?? "1000000";
  if (
    !/^\d+$/u.test(max) ||
    !Number.isSafeInteger(Number(max)) ||
    Number(max) < 1 ||
    Number(max) > 5_000_000
  )
    throw new Error("--max-entries must be an integer between 1 and 5000000");
  if (!options.repo.length && !options.repoRoot.length)
    throw new Error("Select --repo-root or --repo for Git inventory");
  if (
    options.repo.length > maxOwners ||
    options.repoRoot.length > 256 ||
    options.worktreeRoot.length > 256
  )
    throw new Error("Git inventory input limit exceeded");
  const budget = { remaining: Number(max) },
    discovery = { remaining: 50_000 },
    slotsBudget = { remaining: 100_000 };
  const explicit = new Set(options.repo.map((p) => repoPath(p, home)));
  const paths = new Set(explicit),
    parents = [...new Set(options.repoRoot.map((p) => repoPath(p, home)))].sort();
  const env = deps.environment ?? process.env;
  const roots = [
    ...new Set([
      join(home, ".codex", "worktrees"),
      ...(env.CODEX_HOME ? [join(literal(env.CODEX_HOME), "worktrees")] : []),
      ...(env.DOTFILES_WORKTREES_ROOT ? [literal(env.DOTFILES_WORKTREES_ROOT)] : []),
      ...options.worktreeRoot.map(literal),
    ]),
  ];
  if (roots.some((p) => dirname(p) === p || isPathInside(p, home)))
    throw new Error("Select a specific worktree container");
  const statuses = await gitLifecycleInput(
    options.gwtStatusStdin ? (deps.input ?? process.stdin) : undefined,
  );
  const readMounts = deps.mounts ?? (() => readStorageMounts(process.platform));
  const mounts = await readMounts();
  const repoRoots: {
    path: string;
    coverage: string;
    excluded: number;
    directDirectories: number;
  }[] = [];
  for (const literalPath of parents) {
    const path = mounts ? await inventoryPath(literalPath, mounts) : literalPath;
    if (!path) {
      repoRoots.push({
        path: literalPath,
        coverage: "unavailable-volume",
        excluded: 0,
        directDirectories: 0,
      });
      continue;
    }
    const state = await observeStoragePath(path, mounts);
    if (!state.stats?.isDirectory()) {
      repoRoots.push({
        path,
        coverage: state.stats ? "unexpected-kind" : state.status,
        excluded: 0,
        directDirectories: 0,
      });
      continue;
    }
    const existing = await discoverOwner(path, mounts);
    if (existing.coverage !== "not-owner") {
      repoRoots.push({
        path,
        coverage: "requires-repository-parent",
        excluded: 0,
        directDirectories: 0,
      });
      continue;
    }
    const result = await directStorageEntries(path, mounts, discovery, {
      expected: state.stats,
      protect: protectedStorageName,
    });
    let directDirectories = 0,
      omitted = 0;
    for (const entry of result.entries) {
      if (!entry.stats.isDirectory()) continue;
      directDirectories++;
      if (paths.size >= maxOwners && !paths.has(entry.path)) {
        omitted++;
        continue;
      }
      paths.add(entry.path);
    }
    repoRoots.push({
      path,
      coverage: omitted ? "owner-limit" : result.coverage,
      excluded: result.excluded + omitted,
      directDirectories,
    });
  }
  const ledger = new GitIdentityLedger(),
    stores = new Set<string>(),
    repositories: Repository[] = [];
  let nonRepositories = 0;
  for (const literalPath of [...paths].sort()) {
    const path = mounts ? await inventoryPath(literalPath, mounts) : literalPath;
    if (!path) {
      repositories.push({ path: literalPath, coverage: "unavailable-volume" });
      continue;
    }
    const discovery = await discoverOwner(path, mounts);
    if (!discovery.owner || !mounts) {
      if (discovery.coverage === "not-owner" && !explicit.has(literalPath)) nonRepositories++;
      else repositories.push({ path, coverage: discovery.coverage });
      continue;
    }
    const owner = discovery.owner,
      key = owner.commonStats.dev + ":" + owner.commonStats.ino;
    if (stores.has(key)) {
      repositories.push({ path, coverage: "duplicate-store", commonDirectory: owner.common });
      continue;
    }
    stores.add(key);
    const sections = await observeInventorySections(owner.common, mounts);
    const packLedger = new GitIdentityLedger();
    const adminLedger = new GitIdentityLedger();
    const reviews: ReviewRegistrations[] = [];
    const packs = await inventoryPackStore(owner.common, mounts, budget, packLedger);
    const worktrees = await inventoryRegistrations(
      owner,
      roots,
      mounts,
      budget,
      slotsBudget,
      adminLedger,
      statuses,
      reviews,
    );
    const loose = options.looseObjects
      ? await inventoryLooseObjects(owner.common, mounts, budget)
      : undefined;
    const looseObjects = loose?.report;
    let bound = await recheckOwner(owner, mounts, readMounts);
    if (bound && reviews.length) {
      for (const review of reviews) await review(bound.owner, bound.mounts);
      bound = await recheckOwner(owner, mounts, readMounts);
    }
    if (!bound) {
      repositories.push({ path, commonDirectory: owner.common, coverage: "changed" });
      continue;
    }
    const changed = await compareInventorySections(owner.common, sections, mounts, bound.mounts);
    const keepPacks = !changed.objects && !changed.pack;
    const keepRegistrations = !changed.worktrees;
    const sameFormat =
      !changed.config ||
      !looseObjects?.objectFormat ||
      (await gitObjectFormat(owner.common)) === looseObjects.objectFormat;
    const keepLoose =
      sameFormat && (!changed.objects || (loose && (await loose.verifyFanouts(bound.mounts))));
    const changedSections = [
      ...(keepPacks ? [] : ["packs"]),
      ...(keepRegistrations ? [] : ["worktrees"]),
      ...(!keepLoose && looseObjects ? ["looseObjects"] : []),
    ];
    const localLedger = new GitIdentityLedger();
    if (keepPacks) localLedger.merge(packLedger);
    if (keepRegistrations) localLedger.merge(adminLedger);
    ledger.merge(localLedger);
    const coverage =
      changedSections.length ||
      (looseObjects && looseObjects.coverage !== "complete") ||
      packs.changedTemporaryNames ||
      !["direct-complete", "missing"].includes(packs.packCoverage) ||
      packs.objectRootCoverage !== "direct-complete" ||
      packs.excluded ||
      worktrees.coverage !== "complete"
        ? "partial"
        : "complete";
    repositories.push({
      path,
      commonDirectory: owner.common,
      coverage,
      ...(bound.commonMetadataChanged ? { commonMetadataChanged: true } : {}),
      ...(changedSections.length ? { changedSections } : {}),
      ...(keepPacks ? { packs } : {}),
      ...(keepRegistrations ? { worktrees } : {}),
      ...(looseObjects && keepLoose ? { looseObjects } : {}),
      uniqueWithinOwner: localLedger.report(),
    });
  }
  const registrations = repositories.flatMap((r) => r.worktrees?.entries ?? []);
  const counts = new Map<string, number>();
  for (const r of registrations) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
  let conflictingRegistrations = 0;
  for (const r of registrations)
    if (counts.get(r.path) !== 1) {
      r.presence = "withheld";
      r.nativeReview = "retain";
      r.finishedEvidence = null;
      conflictingRegistrations++;
    }
  const bytes = ledger.report(),
    summary = {
      looseObjects: {
        requested: !!options.looseObjects,
        regularNames: options.looseObjects
          ? repositories.reduce((n, r) => n + (r.looseObjects?.regularNames ?? 0), 0)
          : null,
        completeStores: repositories.filter((r) => r.looseObjects?.coverage === "complete").length,
      },
      commonStores: stores.size,
      nonRepositories,
      partialOwners: repositories.filter(
        (r) => !["complete", "duplicate-store"].includes(r.coverage),
      ).length,
      linkedRegistrations: registrations.length,
      nativeListedRegistrations: registrations.filter((r) => r.nativeListed === true).length,
      adminBacklinkOnly: registrations.filter((r) => r.source === "admin-backlink").length,
      missing: registrations.filter((r) => r.presence === "missing").length,
      reciprocal: registrations.filter((r) => r.presence === "reciprocal").length,
      unresolved: registrations.filter(
        (r) => r.presence === "withheld" || r.presence === "present-unverified",
      ).length,
      missingPrunable: registrations.filter((r) => r.presence === "missing" && r.prunable === true)
        .length,
      missingLocked: registrations.filter((r) => r.presence === "missing" && r.locked === true)
        .length,
      prunable: registrations.filter((r) => r.prunable === true).length,
      locked: registrations.filter((r) => r.locked === true).length,
      finishedHeadAndRelease:
        statuses.mode === "inventory-v1"
          ? registrations.filter((r) => r.finishedEvidence?.signedHead).length
          : null,
      enrolledUnpinnedMatchingLock:
        statuses.mode === "inventory-v1"
          ? registrations.filter((r) => r.finishedEvidence?.enrolledLock).length
          : null,
      nativeCloseoutReview:
        statuses.mode === "inventory-v1"
          ? registrations.filter((r) => r.nativeReview === "review-native-closeout").length
          : null,
      gwtEvidence: statuses.mode,
      unmatchedGwtPaths: [...statuses.rows.keys(), ...statuses.legacy.keys()].filter(
        (p) => !counts.has(p),
      ).length,
      conflictingRegistrations,
    };
  const status =
    summary.partialOwners ||
    conflictingRegistrations ||
    bytes.changedIdentitiesOmitted ||
    repoRoots.some((r) => r.coverage !== "direct-complete" || r.excluded)
      ? ("degraded" as const)
      : ("ok" as const);
  return {
    startedAt,
    status,
    data: {
      summary,
      bytes,
      repoRoots,
      repositories,
      bounds: {
        maxEntries: Number(max),
        entriesObserved: Number(max) - budget.remaining,
        ownerDiscoveryLimit: 50_000,
        registrationSlotLimit: 100_000,
        maxOwners,
      },
      worktreeRoots: roots,
      holderStatus: "not-inspected",
      reclaimableBytes: null,
    },
  };
}

export async function executeGitInventory(
  options: GitInventoryOptions,
  dependencies: Dependencies = {},
) {
  const { startedAt, status, data } = await inventoryGitOwners(options, dependencies);
  const view = options.redact ? redactAuditValue(data, options.home, randomUUID()) : data;
  if (options.json)
    return jsonDocument(
      createCommandEnvelope({
        command: "git-inventory",
        startedAt,
        completedAt: new Date().toISOString(),
        status,
        data: view,
      }),
    );
  const { summary: s, bytes: b } = view;
  const lines = [
    `Git inventory (${status}): ${s.commonStores} stores, ${s.partialOwners} partial or withheld owners.`,
    `Observed direct Git files: ${b.uniqueFiles.files} unique identities, ${b.uniqueFiles.logicalBytes} logical bytes, ${b.uniqueFiles.allocatedBytes} allocated bytes; ${b.changedIdentitiesOmitted} changing identities omitted.`,
    `Temporary pack-directory names: ${b.temporaryNames.observedNames}, ${b.temporaryNames.uniqueIdentities.files} unique inodes, ${b.temporaryNames.uniqueIdentities.allocatedBytes} allocated bytes; all observed links temporary: ${b.temporaryNames.allLinksAccountedForAndTemporary.allocatedBytes} allocated bytes; shared with other names: ${b.temporaryNames.alsoHasNonTemporaryName.allocatedBytes}; unknown links: ${b.temporaryNames.unobservedLinks.allocatedBytes}.`,
    `Loose objects: ${s.looseObjects.requested ? `${s.looseObjects.regularNames} observed regular names, ${s.looseObjects.completeStores}/${s.commonStores} complete stores` : "not measured; use --loose-objects"}.`,
    `Observed linked registrations: ${s.linkedRegistrations} (${s.nativeListedRegistrations} Git-listed, ${s.adminBacklinkOnly} admin-backlink only), ${s.reciprocal} reciprocal, ${s.missing} missing (${s.missingPrunable} prunable, ${s.missingLocked} locked), ${s.prunable} Git-prunable, ${s.locked} locked, ${s.unresolved} unresolved.`,
    `Direct files of missing registrations: ${b.missingAdminFiles.allocatedBytes} allocated bytes. Reclaimable bytes unknown.`,
    `GWT evidence: ${s.gwtEvidence}; native closeout review: ${s.gwtEvidence === "inventory-v1" ? s.nativeCloseoutReview : "unverified"}. Confirm holders, protected history and native retirement gates with the allocator.`,
    ...Object.entries(b.byKind).map(
      ([kind, n]) =>
        `${kind}: ${n.files} unique files, ${n.logicalBytes} logical bytes, ${n.allocatedBytes} allocated bytes`,
    ),
    ...Object.entries(b.missingAdminByState).map(
      ([kind, n]) => `Missing registration ${kind}: ${n.allocatedBytes} allocated bytes`,
    ),
    ...view.repoRoots.map(
      (r) => `Repository parent ${r.path}: ${r.coverage}, ${r.excluded} withheld.`,
    ),
    ...view.repositories.map((r) => {
      if (!r.uniqueWithinOwner) return `${r.coverage}  ${r.path}`;
      const files = r.uniqueWithinOwner.temporaryNames;
      const pack = r.packs
        ? `${files.observedNames} temporary names, ${files.uniqueIdentities.allocatedBytes} temporary-name allocated bytes`
        : "pack count withheld";
      const registrations = r.worktrees
        ? `${r.worktrees.entries.length} registration entries`
        : "registration count withheld";
      const changed = r.changedSections?.length
        ? `  changed sections: ${r.changedSections.join(", ")}`
        : "";
      return `${r.coverage}  ${r.path}  ${pack}, ${registrations}${changed}`;
    }),
  ];
  return lines.join("\n") + "\n";
}
