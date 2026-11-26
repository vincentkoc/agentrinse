import { sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GitWorktreeAuditAdapter, GIT_OUTPUT_MAX_BUFFER_BYTES } from "../adapters/git/adapter.js";
import { inventoryGit } from "../adapters/git/inventory-command.js";
import { parseWorktreePorcelain, type GitWorktreeRecord } from "../adapters/git/porcelain.js";
import { createAuditAdapters } from "../adapters/registry.js";
import { loadConfigForHome } from "../config/load.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditAdapter } from "../contracts/adapter.js";
import { runFullAudit } from "../core/audit.js";
import { createProcessOwnershipProbe } from "../core/process-ownership.js";
import { ReachabilityIndex } from "../core/reachability.js";
import { isPathInside } from "../core/safety.js";
import { protectedStorageName } from "../core/storage-measurement.js";
import {
  coveringMount,
  sameStorageMount,
  readStorageMounts,
  type StorageMount,
} from "../core/storage-mounts.js";
import { discoverOwner, recheckOwner, type InventoryOwner } from "../rules/git/inventory-owner.js";
import {
  literalGradePath,
  sameSelectedBinding,
  selectedBinding,
  selectedRecord,
  type SelectedBinding,
} from "../rules/git/selected-binding.js";
import { createCommandEnvelope, jsonDocument } from "../machine-output.js";

type Options = {
  repo: string[];
  worktree: string[];
  home: string;
  config?: string;
  json: boolean;
  redact: boolean;
};
type Row = {
  path: string;
  state: "unknown" | "eligible" | "protected";
  reasons: string[];
  resourceId?: string;
};
type RunGit = typeof inventoryGit;
type Session = {
  owner: InventoryOwner;
  mounts: StorageMount[];
  records: GitWorktreeRecord[];
  config: AgentRinseConfig;
  reachability: ReachabilityIndex;
  run: RunGit;
};

// A configured clean/process filter can run an external program during status. Skip affected
// checkouts. Disable the inspected filters while running status even if attributes change.
async function statusOptions(run: (args: string[]) => Promise<string>) {
  const keys = (await run(["config", "--null", "--name-only", "--list"])).split("\0");
  const drivers = new Set<string>();
  for (const key of keys) {
    const name = /^filter\.(.+)\.(clean|process)$/u.exec(key)?.[1];
    if (name !== undefined) {
      if (!/^[a-zA-Z0-9_-]+$/u.test(name) || drivers.size >= 64)
        throw new Error("unsupported Git filter");
      drivers.add(name);
    }
  }
  const options = ["-c", "diff.ignoreSubmodules=all"];
  if (drivers.size) {
    const affected = await run([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...Array.from(drivers, (name) => ":(attr:filter=" + name + ")"),
    ]);
    if (affected) throw new Error("external Git filter applies");
    for (const name of drivers) {
      options.push(
        "-c",
        "filter." + name + ".clean=",
        "-c",
        "filter." + name + ".process=",
        "-c",
        "filter." + name + ".required=false",
      );
    }
  }
  return options;
}

function targetAdapter(
  session: Session,
  row: Row,
  bindings: Map<string, SelectedBinding>,
): AuditAdapter {
  const { owner, records, mounts, config, reachability } = session;
  let delegate: GitWorktreeAuditAdapter;
  return {
    id: "git",
    probe: async () => ({
      adapter: "git",
      status: "available",
      root: owner.path,
      detail: "Selected registered checkout",
      diagnostics: [],
    }),
    async collect(context, probe) {
      const absent = { resources: [], diagnostics: [] };
      const binding = await selectedBinding(row.path, owner, mounts);
      if (!binding) {
        row.reasons = ["checkout-identity-unverified"];
        return absent;
      }
      bindings.set(row.path, binding);
      const run = async (args: string[]) => {
        context.signal?.throwIfAborted();
        try {
          return await session.run(row.path, args, context.signal!, {
            timeoutMs: config.audit.gitTimeoutMs,
            maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
          });
        } catch (error) {
          if (args.includes("status")) {
            const failure = error as NodeJS.ErrnoException & { killed?: boolean };
            row.reasons = [
              context.signal?.aborted
                ? "grade-deadline"
                : failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  ? "git-status-output-limit"
                  : failure.killed
                    ? "git-status-timeout"
                    : "git-status-unavailable",
            ];
          }
          throw error;
        }
      };
      const expected = [row.path, binding.admin, owner.common].join("\n") + "\n";
      try {
        if (
          (await run([
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
          ])) !== expected
        ) {
          row.reasons = ["checkout-identity-unverified"];
          return absent;
        }
        const options = await statusOptions(run);
        delegate = new GitWorktreeAuditAdapter(
          owner.path,
          (args) => {
            if (args[0] !== "-C" || args[1] !== row.path)
              throw new Error("unselected Git checkout");
            const command = args.slice(2);
            return run(command[0] === "status" ? [...options, ...command] : command);
          },
          undefined,
          createProcessOwnershipProbe({
            platform: process.platform,
            timeoutMs: config.audit.processOwnershipTimeoutMs,
          }),
          reachability,
          { ...config.audit, ...config.worktrees, platform: process.platform },
          { discovery: { records }, selectedPath: row.path },
        );
      } catch {
        row.reasons = ["git-read-only-inspection-unavailable"];
        return absent;
      }
      return delegate.collect(context, probe);
    },
    classify(context, resource) {
      return delegate.classify(context, resource);
    },
  };
}

export async function executeWorktreeGrades(
  options: Options,
  run: RunGit = inventoryGit,
): Promise<string> {
  if (options.repo.length !== 1 || !literalGradePath(options.repo[0]!))
    throw new Error("worktree-grades requires one literal absolute --repo");
  const inputs = options.worktree;
  if (!inputs.length || inputs.length > 64)
    throw new Error("select 1 to 64 literal --worktree paths");
  const repo = options.repo[0]!;
  const startedAt = new Date().toISOString();
  const { config } = await loadConfigForHome(options.home, options.config);
  const rows: Row[] = inputs.map((path) => ({
    path,
    state: "unknown",
    reasons: ["owner-unverified"],
  }));
  const mounts = await readStorageMounts(process.platform);
  const owner =
    mounts && !isPathInside(repo, options.home) && !repo.split(sep).some(protectedStorageName)
      ? (await discoverOwner(repo, mounts)).owner
      : undefined;
  let registered: number | null = null;
  if (owner && mounts) {
    const roster = async () => {
      try {
        const records = parseWorktreePorcelain(
          await run(
            repo,
            ["worktree", "list", "--porcelain", "-z"],
            AbortSignal.timeout(config.audit.gitTimeoutMs),
            { timeoutMs: config.audit.gitTimeoutMs },
          ),
        );
        if (records[0]?.path === repo && selectedRecord(records, repo)) return records;
      } catch {
        /* Unavailable native membership never admits a checkout. */
      }
      return undefined;
    };
    const records = await roster();
    if (!records) {
      for (const row of rows) row.reasons = ["native-roster-unverified"];
    } else {
      registered = records.length;
      const reachability = new ReachabilityIndex();
      // Preserve provider ownership and every configured pin, with no sibling or artifact consumer.
      config.adapters.git = { enabled: true, root: repo };
      config.adapters.runtime = config.adapters.docker = { enabled: false };
      config.artifacts.projects = [];
      const adapters = createAuditAdapters(config, process.platform, {
        gitRepositories: [],
        reachability,
        providerInventory: false,
      });
      const session = { owner, mounts, records, config, reachability, run };
      const bindings = new Map<string, SelectedBinding>();
      for (const row of rows) {
        if (!literalGradePath(row.path)) row.reasons = ["nonliteral-path"];
        else if (inputs.indexOf(row.path) !== inputs.lastIndexOf(row.path))
          row.reasons = ["duplicate-selection"];
        else if (row.path === repo) row.reasons = ["main-worktree"];
        else if (isPathInside(row.path, options.home) || isPathInside(row.path, repo))
          row.reasons = ["out-of-scope"];
        else if (!selectedRecord(records, row.path)) row.reasons = ["registration-unverified"];
        else {
          row.reasons = ["grade-incomplete"];
          adapters.push(targetAdapter(session, row, bindings));
        }
      }
      if (adapters.some((adapter) => adapter.id === "git")) {
        const audit = await runFullAudit({ home: options.home, config, adapters });
        const nowMounted = await readStorageMounts(process.platform);
        const sameMount = (path: string) => {
          const before = coveringMount(path, mounts),
            after = nowMounted && coveringMount(path, nowMounted);
          return (
            before?.access === "local" &&
            after?.access === "local" &&
            sameStorageMount(before, after)
          );
        };
        const checked =
          nowMounted && sameMount(owner.common) && sameMount(owner.path)
            ? await recheckOwner(owner, nowMounted, async () => nowMounted)
            : undefined;
        const after = checked && (await roster());
        for (const row of rows) {
          const binding = bindings.get(row.path);
          if (!binding) continue;
          if (!checked || !after) {
            row.reasons = [checked ? "final-roster-unverified" : "owner-recheck-unverified"];
            continue;
          }
          const record = selectedRecord(records, row.path)!;
          if (!isDeepStrictEqual(record, selectedRecord(after, row.path))) {
            row.reasons = ["registration-changed"];
            continue;
          }
          const refreshed = await selectedBinding(row.path, owner, checked.mounts);
          if (!refreshed || !sameMount(row.path) || !sameMount(binding.admin)) {
            row.reasons = ["checkout-recheck-unverified"];
            continue;
          }
          if (!sameSelectedBinding(binding, refreshed)) {
            row.reasons = ["registration-changed"];
            continue;
          }
          const finding = audit.findings.find(
            (f) => f.resource.kind === "git-worktree" && f.resource.path === row.path,
          );
          if (!finding) continue;
          if (
            typeof finding.facts.head !== "string" ||
            typeof finding.facts.repositoryCommonDir !== "string" ||
            (record.branch !== undefined && typeof finding.facts.branch !== "string")
          ) {
            // The physical binding was verified. An unfinished Git probe is missing evidence,
            // not a contradiction. Keep independent provider, pin and native lock observations.
            const retained = finding.roots.filter(
              (root) =>
                !["git", "process"].includes(root.source) ||
                ["git-lock", "detached-worktree", "worktree-registration-unsafe"].includes(
                  root.code,
                ),
            );
            row.reasons = [
              ...new Set([
                "git-evidence-incomplete",
                ...row.reasons.filter((reason) => reason !== "grade-incomplete"),
                ...retained.map((root) => root.code),
                ...(reachability.activeGitRefs(finding.observedAt).length
                  ? ["git-ref-inspection-incomplete"]
                  : []),
              ]),
            ].sort();
            continue;
          }
          if (
            finding.facts.head !== record.head ||
            finding.facts.repositoryCommonDir !== owner.common ||
            (record.branch !== undefined &&
              finding.facts.branch !== record.branch.replace(/^refs\/heads\//u, ""))
          ) {
            row.reasons = ["grade-identity-mismatch"];
            continue;
          }
          row.resourceId = finding.resource.id;
          row.reasons = [...new Set(finding.roots.map((root) => root.code))].sort();
          if (finding.facts.remoteHistoryComplete === false) {
            row.reasons = row.reasons.filter((code) => code !== "unpushed-commit");
            row.reasons.push("remote-history-incomplete");
          }
          if (finding.facts.gitRefInspectionComplete === false)
            row.reasons.push("git-ref-inspection-incomplete");
          if (
            finding.state === "unknown" ||
            row.reasons.some(
              (code) => code.includes("incomplete") || code === "unknown-provider-state",
            ) ||
            (finding.facts.remoteConfigured === true &&
              finding.facts.remoteReachable !== true &&
              finding.facts.unpushed !== true)
          ) {
            if (!row.reasons.length) row.reasons.push("reachability-unverified");
          } else if (finding.state === "eligible" || finding.state === "protected")
            row.state = finding.state;
        }
      }
    }
  }
  const unknown = rows.filter((row) => row.state === "unknown").length;
  const data = {
    selected: rows.length,
    graded: rows.length - unknown,
    unknown,
    registered,
    rows: rows.map(({ path, resourceId, ...grade }, index) => ({
      index,
      ...grade,
      ...(options.redact ? {} : { path, resourceId }),
    })),
  };
  if (options.json)
    return jsonDocument(
      createCommandEnvelope({
        command: "worktree-grades",
        startedAt,
        completedAt: new Date().toISOString(),
        status: unknown ? "degraded" : "ok",
        data,
      }),
    );
  return (
    [
      data.graded + " graded, " + unknown + " unknown of " + rows.length + " selected",
      ...data.rows.map(
        (r) => (r.path ?? "#" + (r.index + 1)) + "\t" + r.state + "\t" + r.reasons.join(", "),
      ),
    ].join("\n") + "\n"
  );
}
