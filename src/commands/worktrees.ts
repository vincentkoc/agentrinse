import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parseWorktreePorcelain, type GitWorktreeRecord } from "../adapters/git/porcelain.js";
import { missingAdminSizes, registeredCheckoutPath } from "../adapters/git/worktree-admin-size.js";
import { measurePath } from "../core/measure.js";
import { redactAuditValue } from "../core/redaction.js";
import { isPathInside } from "../core/safety.js";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";
import {
  lifecycleFor,
  ownerSignoffFor,
  readGwtStatus,
  type Lifecycle,
} from "./worktree-lifecycle.js";

const exec = promisify(execFile);
const DISCOVERY_LIMIT = 50_000;
const TIME_BUDGET_MS = 180_000;

type Root = { path: string; status: "available" | "absent" | "incomplete" };
type Kind = "registered-linked" | "standalone" | "unresolved" | "missing";
type Size = { status: "complete" | "lower-bound" | "unavailable"; logicalBytes: number | null };
type Entry = {
  path: string;
  kind: Kind;
  ownerRepository?: string;
  directoryAgeDays?: number;
  locked?: boolean;
  gwtLock?: boolean;
  prunable?: boolean;
  lifecycle: Lifecycle;
  ownerSignoff: ReturnType<typeof ownerSignoffFor>;
  disposition: "review-native-closeout" | "recorded-removed" | "retain";
  size?: Size;
  adminDirectFileBytes?: number | null;
};
type Options = {
  home: string;
  root: string[];
  repo: string[];
  projectRoots?: boolean;
  measure?: boolean;
  maxEntries?: string;
  gwtStatusStdin?: boolean;
  json?: boolean;
  redact?: boolean;
};
type Dependencies = { environment?: NodeJS.ProcessEnv; input?: AsyncIterable<Uint8Array> };

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function git(path: string, args: string[], signal: AbortSignal): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await exec(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=",
      "-c",
      "protocol.allow=never",
      "-C",
      path,
      ...args,
    ],
    {
      env: {
        ...env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
      },
      encoding: "utf8",
      signal,
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout;
}

function absolute(path: string): string {
  if (!isAbsolute(path)) throw new Error("Worktree inventory paths must be absolute");
  return resolve(path);
}

function withinRoot(roots: Root[], path: string): boolean {
  return roots.some((root) => {
    const parts = relative(root.path, path).split(sep);
    return (
      root.status === "available" &&
      path !== root.path &&
      isPathInside(root.path, path) &&
      parts.length <= 2
    );
  });
}

export async function inventoryWorktrees(options: Options, dependencies: Dependencies = {}) {
  const started = new Date();
  const home = absolute(options.home);
  const env = dependencies.environment ?? process.env;
  const configured = [...options.root];
  if (!configured.length) {
    configured.push(join(home, ".codex", "worktrees"));
    if (env.CODEX_HOME) configured.push(join(absolute(env.CODEX_HOME), "worktrees"));
    if (env.DOTFILES_WORKTREES_ROOT) configured.push(absolute(env.DOTFILES_WORKTREES_ROOT));
  }
  if (options.projectRoots && !options.repo.length)
    throw new Error("--project-roots requires --repo");
  const paths = new Set(configured.map(absolute));
  if ([...paths].some((path) => isPathInside(path, home) || dirname(path) === path))
    throw new Error(
      "Refusing the home, its ancestors, or a filesystem root as a worktree container",
    );
  const maxEntries = Number(options.maxEntries ?? 10_000);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000)
    throw new Error("--max-entries must be between 1 and 1000000");
  if (options.maxEntries !== undefined && !/^\d+$/u.test(options.maxEntries))
    throw new Error("--max-entries must be a positive integer");
  const statuses: Awaited<ReturnType<typeof readGwtStatus>> = options.gwtStatusStdin
    ? await readGwtStatus(dependencies.input ?? process.stdin)
    : new Map();
  const deadline = AbortSignal.timeout(TIME_BUDGET_MS);
  const roots: Root[] = [];
  const entries = new Map<string, Entry>();
  const registrations = new Map<string, GitWorktreeRecord>();
  const owners = new Map<string, string>();
  const conflicting = new Set<string>();
  const repositories = new Map<string, GitWorktreeRecord[]>();
  const explicitRegistrations = new Map<string, string>();
  const problems: { path: string; code: string }[] = [];
  let inspected = 0;

  function entry(path: string, kind: Kind): Entry {
    const value: Entry = {
      path,
      kind,
      lifecycle: lifecycleFor(statuses.get(path)),
      ownerSignoff: ownerSignoffFor(statuses.get(path)),
      disposition: "retain",
    };
    entries.set(path, value);
    return value;
  }

  async function readRepository(path: string, explicit = false) {
    if ((await realpath(path)) !== path) throw new Error("aliased checkout");
    const top = (await git(path, ["rev-parse", "--show-toplevel"], deadline)).replace(
      /\r?\n$/u,
      "",
    );
    if (resolve(top) !== path) throw new Error("parent repository");
    const common = (
      await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline)
    ).replace(/\r?\n$/u, "");
    let records = repositories.get(common);
    if (!records) {
      records = parseWorktreePorcelain(
        await git(path, ["worktree", "list", "--porcelain", "-z"], deadline),
      );
      repositories.set(common, records);
      for (const record of records) {
        const checkout = resolve(record.path);
        if (registrations.has(checkout)) conflicting.add(checkout);
        registrations.set(checkout, record);
        if (records[0]) owners.set(checkout, resolve(records[0].path));
      }
    }
    if (explicit && records[0]) {
      const owner = resolve(records[0].path);
      for (const record of records.slice(1)) explicitRegistrations.set(resolve(record.path), owner);
    }
    return records.find((record) => resolve(record.path) === path);
  }

  async function scan(directory: string, depth: number, device: number): Promise<number> {
    let directoryEntries = 0;
    const children = await opendir(directory);
    for await (const child of children) {
      if (++inspected > DISCOVERY_LIMIT || deadline.aborted) throw new Error("discovery limit");
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      directoryEntries++;
      const path = join(directory, child.name);
      if (entries.has(path)) continue;
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== device) {
          entry(path, "unresolved");
          continue;
        }
        let marker;
        try {
          marker = await lstat(join(path, ".git"));
        } catch (error) {
          if (!missing(error)) throw error;
        }
        if (!marker && depth === 1) {
          if ((await scan(path, 2, device)) === 0) entry(path, "unresolved");
          continue;
        }
        const item = entry(path, "unresolved");
        item.directoryAgeDays = Math.max(
          0,
          Math.floor((started.getTime() - stats.mtimeMs) / 86_400_000),
        );
        if (!marker || (!marker.isFile() && !marker.isDirectory())) continue;
        const record = await readRepository(path);
        if (!record) continue;
        // The main checkout may also use a gitfile (e.g. --separate-git-dir).
        if (owners.get(path) === path) item.kind = "standalone";
        else {
          const admin = (await git(path, ["rev-parse", "--absolute-git-dir"], deadline)).replace(
            /\r?\n$/u,
            "",
          );
          if ((await registeredCheckoutPath(resolve(admin))) !== path) continue;
          item.kind = "registered-linked";
        }
        item.lifecycle = lifecycleFor(statuses.get(path), record.head);
        item.ownerSignoff = ownerSignoffFor(statuses.get(path), record.head);
        item.locked = record.locked !== undefined;
        item.gwtLock = /^gwt-finish\.v2:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(
          record.locked ?? "",
        );
        item.prunable = record.prunable !== undefined;
        if (
          item.kind === "registered-linked" &&
          item.gwtLock &&
          ((item.lifecycle === "finished" && item.ownerSignoff === "released") ||
            (item.lifecycle === "cancelled" && item.ownerSignoff === "cancelled"))
        )
          item.disposition = "review-native-closeout";
      } catch {
        entry(path, "unresolved");
        problems.push({ path, code: "WORKTREE_INSPECTION_INCOMPLETE" });
      }
    }
    return directoryEntries;
  }

  for (const path of new Set(options.repo.map(absolute))) {
    try {
      const record = await readRepository(path, true);
      if (options.projectRoots) {
        if (!record || owners.get(path) !== path) {
          problems.push({ path, code: "WORKTREE_PROJECT_OWNER_REQUIRED" });
          continue;
        }
        const device = (await lstat(path)).dev;
        // Validate each parent before looking up a child underneath it.
        for (const parts of [[".worktrees"], [".claude", "worktrees"]]) {
          let current = path;
          try {
            for (const part of parts) {
              current = join(current, part);
              const stats = await lstat(current);
              if (
                !stats.isDirectory() ||
                stats.dev !== device ||
                (await realpath(current)) !== current
              )
                throw new Error("unsafe project worktree container");
            }
            if (isPathInside(current, home)) throw new Error("unsafe project worktree container");
            paths.add(current);
          } catch (error) {
            if (!missing(error))
              problems.push({ path: current, code: "WORKTREE_PROJECT_ROOT_INCOMPLETE" });
          }
        }
      }
    } catch {
      problems.push({ path, code: "WORKTREE_REGISTRATIONS_UNAVAILABLE" });
    }
  }
  for (const path of [...paths].sort()) {
    const root: Root = { path, status: "available" };
    roots.push(root);
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || (await realpath(path)) !== path) throw new Error("unsafe root");
      try {
        await lstat(join(path, ".git"));
        throw new Error("root is a checkout");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await scan(path, 1, stats.dev);
    } catch (error) {
      root.status = missing(error) ? "absent" : "incomplete";
      if (root.status === "incomplete") problems.push({ path, code: "WORKTREE_ROOT_INCOMPLETE" });
    }
  }
  const externalRegistrations: {
    path: string;
    ownerRepository: string;
    presence: "directory" | "missing" | "unresolved";
  }[] = [];
  for (const [path, ownerRepository] of explicitRegistrations) {
    if (withinRoot(roots, path) || entries.has(path)) continue;
    let presence: "directory" | "missing" | "unresolved" = "unresolved";
    try {
      if (!deadline.aborted && (await realpath(dirname(path))) === dirname(path)) {
        const stats = await lstat(path);
        if (stats.isDirectory()) presence = "directory";
      }
    } catch (error) {
      if (missing(error)) presence = "missing";
    }
    externalRegistrations.push({ path, ownerRepository, presence });
  }
  let historicalMissing = 0;
  for (const path of new Set([...registrations.keys(), ...statuses.keys()])) {
    if (entries.has(path) || !withinRoot(roots, path)) continue;
    try {
      // Only inspect a literal registration below a verified container. A linked
      // parent may point outside it, so keep parent identity failures unresolved.
      const parent = dirname(path);
      try {
        const stats = await lstat(parent);
        if (!stats.isDirectory() || (await realpath(parent)) !== parent) {
          entry(path, "unresolved");
          continue;
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await lstat(path);
      entry(path, "unresolved");
    } catch (error) {
      const item = entry(path, missing(error) ? "missing" : "unresolved");
      if (item.kind === "missing" && item.lifecycle === "removed" && !registrations.has(path)) {
        item.disposition = "recorded-removed";
        historicalMissing++;
      }
    }
  }
  const measurementDeadline = AbortSignal.timeout(TIME_BUDGET_MS);
  if (options.measure) {
    for (const [common, records] of repositories) {
      const missing = new Set(
        records
          .map((record) => resolve(record.path))
          .filter((path) => entries.get(path)?.kind === "missing"),
      );
      if (!missing.size) continue;
      const sizes = await missingAdminSizes(common, missing, measurementDeadline).catch(
        () => new Map<string, number>(),
      );
      for (const path of missing) {
        const item = entries.get(path);
        if (item) item.adminDirectFileBytes = sizes.get(path) ?? null;
      }
    }
  }
  const items = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const item of items) {
    if (conflicting.has(item.path)) {
      item.kind = "unresolved";
      item.disposition = "retain";
      problems.push({ path: item.path, code: "WORKTREE_REGISTRATION_CONFLICT" });
      continue;
    }
    if (item.kind === "missing") {
      const registration = registrations.get(item.path);
      if (registration) {
        item.prunable = registration.prunable !== undefined;
        item.locked = registration.locked !== undefined;
      }
    }
    const owner = owners.get(item.path);
    if (owner) item.ownerRepository = owner;
    if (options.measure && (item.kind === "registered-linked" || item.kind === "standalone")) {
      try {
        const result = await measurePath(item.path, { maxEntries, signal: measurementDeadline });
        item.size = {
          status: result.truncated || result.mountBoundaries ? "lower-bound" : "complete",
          logicalBytes: result.bytes,
        };
      } catch {
        item.size = { status: "unavailable", logicalBytes: null };
      }
    }
  }
  const summary = {
    registeredLinked: items.filter((i) => i.kind === "registered-linked").length,
    standalone: items.filter((i) => i.kind === "standalone").length,
    unresolved: items.filter((i) => i.kind === "unresolved").length,
    missing: items.filter((i) => i.kind === "missing").length,
    historicalMissing,
    checkoutSizesUnmeasured: items.filter(
      (item) => item.kind !== "missing" && item.size?.logicalBytes == null,
    ).length,
    missingRegistrations: items.filter((i) => i.kind === "missing" && registrations.has(i.path))
      .length,
    finishedAwaitingSignoff: items.filter(
      (i) =>
        i.kind === "registered-linked" &&
        i.lifecycle === "finished" &&
        i.ownerSignoff !== "released",
    ).length,
    observedLogicalBytesByDisposition: options.measure
      ? {
          nativeCloseoutReview: items
            .filter((i) => i.disposition === "review-native-closeout")
            .reduce((n, i) => n + (i.size?.logicalBytes ?? 0), 0),
          retained: items
            .filter((i) => i.disposition === "retain")
            .reduce((n, i) => n + (i.size?.logicalBytes ?? 0), 0),
        }
      : null,
    externalRegisteredDirectories: externalRegistrations.filter((r) => r.presence === "directory")
      .length,
    externalMissing: externalRegistrations.filter((r) => r.presence === "missing").length,
    externalUnresolved: externalRegistrations.filter((r) => r.presence === "unresolved").length,
    missingAdminDirectFileBytes: options.measure
      ? items.reduce((n, i) => n + (i.adminDirectFileBytes ?? 0), 0)
      : null,
    missingAdminMeasurementsUnavailable: items.filter((i) => i.adminDirectFileBytes === null)
      .length,
    presentByLifecycle: Object.fromEntries(
      (
        [
          "active",
          "finished",
          "cancelled",
          "pinned",
          "unresolved",
          "removed",
          "unreported",
        ] as const
      ).map((lifecycle) => [
        lifecycle,
        items.filter((i) => i.kind !== "missing" && i.lifecycle === lifecycle).length,
      ]),
    ),
    nativeCloseoutReview: items.filter((i) => i.disposition === "review-native-closeout").length,
    logicalBytesMeasured: options.measure
      ? items.reduce((n, i) => n + (i.size?.logicalBytes ?? 0), 0)
      : null,
    partialMeasurements: items.filter((i) => i.size && i.size.status !== "complete").length,
  };
  return {
    startedAt: started.toISOString(),
    roots,
    summary,
    entries: items,
    externalRegistrations,
    problems,
  };
}

export async function executeWorktreesCommand(options: Options): Promise<string> {
  const report = await inventoryWorktrees(options);
  const { startedAt, ...data } = report;
  const status =
    (options.root.length && data.roots.some((root) => root.status !== "available")) ||
    data.problems.length ||
    data.summary.unresolved ||
    data.summary.externalUnresolved ||
    data.summary.partialMeasurements ||
    data.summary.missingAdminMeasurementsUnavailable
      ? "degraded"
      : "ok";
  const view = options.redact ? redactAuditValue(data, options.home, randomUUID()) : data;
  if (options.json)
    return jsonDocument(
      createCommandEnvelope({
        command: "worktrees",
        startedAt,
        completedAt: new Date().toISOString(),
        status,
        data: view,
      }),
    );
  const { summary } = view;
  return (
    [
      `Worktree inventory (${status}): ${summary.registeredLinked} registered linked, ${summary.standalone} standalone, ${summary.unresolved} unresolved, ${summary.missing} missing (${summary.historicalMissing} historical).`,
      `Native closeout review: ${summary.nativeCloseoutReview}. The path-matched result is provisional. Confirm checkout identity, HEAD, owners, holders, pins and history with the allocator.`,
      ...(options.measure
        ? [
            `Checkout logical bytes observed: ${summary.logicalBytesMeasured} (${summary.partialMeasurements} partial or unavailable). Direct Git admin file bytes for missing registrations: ${summary.missingAdminDirectFileBytes} (${summary.missingAdminMeasurementsUnavailable} unavailable).`,
          ]
        : []),
      `Outside selected roots, explicit repositories register ${summary.externalRegisteredDirectories} existing directories, ${summary.externalMissing} missing and ${summary.externalUnresolved} unresolved. Sizes require selecting their container.`,
      ...view.roots.map((root) => `Root ${root.status}: ${root.path}`),
      ...view.entries
        .filter((item) => item.disposition !== "recorded-removed")
        .map(
          (item) =>
            `${item.kind}  ${item.lifecycle}  ${item.disposition}  ${item.path}${item.size ? `  ${item.size.logicalBytes ?? "?"} logical bytes (${item.size.status})` : ""}`,
        ),
      ...view.problems.map((problem) => `${problem.code}: ${problem.path}`),
    ].join("\n") + "\n"
  );
}
