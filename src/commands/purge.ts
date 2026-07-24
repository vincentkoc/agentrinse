import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { listGitRefsForCommit } from "../adapters/git/refs.js";
import { createAuditAdapters } from "../adapters/registry.js";
import { PROVIDER_SPECS } from "../adapters/provider-specs.js";
import { loadConfigForHome } from "../config/load.js";
import type { AgentRinseConfig } from "../config/schema.js";
import type { AuditContext } from "../contracts/adapter.js";
import type { RootEvidence } from "../contracts/finding.js";
import { quarantineEntrySchema, type QuarantineEntry } from "../contracts/quarantine.js";
import type { ResourceRef } from "../contracts/resource.js";
import { ReachabilityIndex } from "../core/reachability.js";
import {
  purgeWorktreeQuarantine,
  worktreePurgeIsolationPath,
  type PurgeWorktreeOptions,
} from "../core/worktree-recovery.js";
import { ensurePrivateDirectory } from "../state/json-file.js";
import { resolveStateRoot, stateLayout } from "../state/layout.js";
import { acquireApplyLock } from "../state/lock.js";
import { listJsonRecordFiles } from "../state/records.js";
import { confirmMutation, type ConfirmationDependencies } from "./confirmation.js";

const execFileAsync = promisify(execFile);

async function defaultGitRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  return result.stdout;
}

export type PurgeCommandOptions = {
  home: string;
  config?: string;
  stateDir?: string;
  expired: boolean;
  runId?: string;
  apply: boolean;
  yes: boolean;
  json: boolean;
  now?: Date;
  dependencies?: ConfirmationDependencies & {
    purge?: (
      entry: QuarantineEntry,
      options: PurgeWorktreeOptions,
    ) => Promise<{ entry: QuarantineEntry; reclaimedBytes: number }>;
    runGit?: (args: string[]) => Promise<string>;
  };
};

export type PurgeCommandResult = {
  entries: QuarantineEntry[];
  applied: boolean;
  reclaimedBytes: number;
  output: string;
};

async function currentProtectionRoots(
  entry: QuarantineEntry,
  home: string,
  config: AgentRinseConfig,
  now: Date,
  runGit: (args: string[]) => Promise<string>,
): Promise<RootEvidence[]> {
  const reachability = new ReachabilityIndex();
  const adapters = createAuditAdapters(config, process.platform, {
    providerInventory: false,
    reachability,
  }).filter((adapter) => Object.hasOwn(PROVIDER_SPECS, adapter.id));
  const context: AuditContext = {
    home,
    now,
    auditId: `purge-${entry.entryId}`,
  };
  for (const adapter of adapters) {
    const probe = await adapter.probe(context);
    await adapter.collect(context, probe);
  }

  const resource: ResourceRef = {
    id: entry.resourceId,
    adapter: "git",
    kind: "git-worktree",
    canonicalKey: `git:git-worktree:${entry.originalPath}`,
    displayName: "Quarantined linked worktree",
    path: entry.originalPath,
  };
  const observedAt = now.toISOString();
  const currentRefs = config.pins.some((pin) => "gitRef" in pin)
    ? await listGitRefsForCommit(
        (args) => runGit(["--git-dir", entry.target.repositoryCommonDir, ...args]),
        entry.target.head,
      )
    : { gitRefs: [] };
  const facts = {
    ...(entry.target.branch === undefined ? {} : { branch: entry.target.branch }),
    gitRefs: [
      ...(entry.target.branch === undefined ? [] : [entry.target.branch]),
      ...currentRefs.gitRefs,
    ],
  };
  const roots = [
    ...reachability.rootsForResource(resource, facts, observedAt),
    ...reachability.rootsFor(entry.quarantinePath, observedAt),
    ...reachability.rootsFor(worktreePurgeIsolationPath(entry), observedAt),
  ];
  const unique = new Map(
    roots.map((root) => [
      `${root.code}\0${root.source}\0${root.evidenceRef ?? ""}\0${root.detail}`,
      root,
    ]),
  );
  return [...unique.values()];
}

function renderPreview(entries: QuarantineEntry[], now: Date): string {
  if (entries.length === 0) {
    return "No matching quarantine entries.\n";
  }
  const lines = ["AgentRinse quarantine purge preview", ""];
  for (const entry of entries) {
    lines.push(
      `${entry.entryId}  run=${entry.runId}  bytes=${entry.target.measuredBytes}  ${
        Date.parse(entry.expiresAt) <= now.getTime() ? "expired" : `expires=${entry.expiresAt}`
      }`,
    );
  }
  lines.push("", "Preview only. Add --apply and --yes to purge.");
  return `${lines.join("\n")}\n`;
}

export async function executePurgeCommand(
  options: PurgeCommandOptions,
): Promise<PurgeCommandResult> {
  if (options.expired && options.runId !== undefined) {
    throw new Error("purge accepts only one of --expired or --run");
  }
  if (options.apply && !options.expired && options.runId === undefined) {
    throw new Error("purge --apply requires --expired or --run");
  }
  if (options.json && options.apply && !options.yes) {
    throw new Error("purge --json --apply requires --yes");
  }
  const now = options.now ?? new Date();
  const home = resolve(options.home);
  const layout = stateLayout(resolveStateRoot(home, options.stateDir));
  const records = await listJsonRecordFiles(layout.quarantine, quarantineEntrySchema);
  for (const record of records) {
    if (record.name !== `${record.value.entryId}.json`) {
      throw new Error(`quarantine manifest entry ID does not match filename: ${record.name}`);
    }
  }
  const live = records.filter(({ value }) => ["quarantined", "purging"].includes(value.status));
  const entries = live.filter(({ value: entry }) =>
    options.expired
      ? Date.parse(entry.expiresAt) <= now.getTime()
      : options.runId === undefined || entry.runId === options.runId,
  );

  if (!options.apply) {
    return {
      entries: entries.map((record) => record.value),
      applied: false,
      reclaimedBytes: 0,
      output: options.json
        ? `${JSON.stringify(
            { applied: false, entries: entries.map((record) => record.value) },
            null,
            2,
          )}\n`
        : renderPreview(
            entries.map((record) => record.value),
            now,
          ),
    };
  }
  if (entries.length === 0) {
    throw new Error("no matching live quarantine entries to purge");
  }
  if (
    !options.yes &&
    !(await confirmMutation(
      `Permanently purge ${entries.length} quarantined worktree(s)? [y/N] `,
      options.dependencies,
    ))
  ) {
    throw new Error("purge cancelled");
  }

  await ensurePrivateDirectory(layout.locks);
  const operationId = randomUUID();
  const lock = await acquireApplyLock(layout.locks, {
    planId: `purge:${options.runId ?? "expired"}`,
    runId: operationId,
    command: "agentrinse purge",
  });
  const purged: QuarantineEntry[] = [];
  let reclaimedBytes = 0;
  const runGit = options.dependencies?.runGit ?? defaultGitRunner;
  try {
    for (const record of entries) {
      const entry = record.value;
      const revalidateProtection = async (candidate: QuarantineEntry): Promise<void> => {
        const { config } = await loadConfigForHome(home, options.config);
        const protectionRoots = await currentProtectionRoots(candidate, home, config, now, runGit);
        if (protectionRoots.length > 0) {
          const codes = [...new Set(protectionRoots.map((root) => root.code))].sort();
          throw new Error(
            `purge refused protected quarantine entry ${candidate.entryId}: ${codes.join(", ")}`,
          );
        }
      };
      await revalidateProtection(entry);
      const result = await (options.dependencies?.purge ?? purgeWorktreeQuarantine)(entry, {
        manifestPath: record.path,
        quarantineDirectory: layout.quarantine,
        allowUnexpired: options.runId !== undefined,
        revalidateProtection,
      });
      purged.push(result.entry);
      reclaimedBytes += result.reclaimedBytes;
    }
  } finally {
    await lock.release();
  }

  return {
    entries: purged,
    applied: true,
    reclaimedBytes,
    output: options.json
      ? `${JSON.stringify({ applied: true, reclaimedBytes, entries: purged }, null, 2)}\n`
      : `purged ${purged.length} quarantined worktree(s); reclaimed ${reclaimedBytes} bytes\n`,
  };
}
