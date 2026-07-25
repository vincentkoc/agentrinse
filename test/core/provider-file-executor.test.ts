import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { ProviderFileQuarantineAction } from "../../src/contracts/action.js";
import {
  providerFileQuarantineEntrySchema,
  type ProviderFileQuarantineEntry,
} from "../../src/contracts/provider-file-quarantine.js";
import {
  executeProviderFileQuarantine,
  providerFileQuarantinePath,
} from "../../src/core/provider-file-executor.js";
import { inspectProviderFile } from "../../src/core/provider-file-identity.js";
import {
  purgeProviderFileQuarantine,
  providerFilePurgeIsolationPath,
  undoProviderFileQuarantine,
} from "../../src/core/provider-file-recovery.js";
import { writeJsonAtomic, readJsonFile } from "../../src/state/json-file.js";

const NOW = new Date("2026-07-25T00:00:00.000Z");
const execFileAsync = promisify(execFile);

function idleDependencies() {
  return {
    clock: () => NOW,
    move: rename,
    authorizeTarget: async () => undefined,
    inspectProcesses: async () => ({ status: "idle" as const, pids: [] as [] }),
    inspectOpenHandles: async () => ({ status: "idle" as const, matches: [] as [] }),
  };
}

async function fixture(): Promise<{
  action: ProviderFileQuarantineAction;
  file: string;
  ownerRoot: string;
  quarantineDirectory: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-provider-file-"));
  const ownerRoot = join(home, ".claude");
  const debug = join(ownerRoot, "debug");
  const file = join(debug, "session.txt");
  const quarantineDirectory = join(home, "state", "provider-quarantine");
  await mkdir(debug, { recursive: true });
  await writeFile(file, "synthetic debug output\n", { mode: 0o640 });
  const target = await inspectProviderFile(file, ownerRoot, "claude");
  return {
    file,
    ownerRoot,
    quarantineDirectory,
    action: {
      actionId: "provider.file-quarantine:fixture",
      type: "provider.file-quarantine",
      adapter: "claude",
      resourceId: "claude:agent-log:fixture",
      policyId: "claude.debug-log",
      risk: "recoverable",
      description: "archive a synthetic Claude debug log",
      expectedReclaimBytes: 0,
      pendingQuarantineBytes: target.measuredBytes,
      quarantineTtlMinutes: 60,
      target,
    },
  };
}

describe("provider-file quarantine execution and recovery", () => {
  it("quarantines an exact regular file and restores it through undo", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-1",
      entryId: "entry-1",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });

    await expect(lstat(selected.file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(result.quarantinePath, "utf8")).resolves.toBe("synthetic debug output\n");
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    expect(manifest.status).toBe("quarantined");
    expect(result.quarantinedBytes).toBe(selected.action.target.measuredBytes);

    const restored = await undoProviderFileQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });

    expect(restored.status).toBe("restored");
    await expect(readFile(selected.file, "utf8")).resolves.toBe("synthetic debug output\n");
    expect((await lstat(selected.file)).mode).toBe(selected.action.target.mode);
    await expect(lstat(result.quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("purges a quarantined file only through its durable manifest", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-purge",
      entryId: "entry-purge",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    const purged = await purgeProviderFileQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      allowUnexpired: true,
      dependencies: idleDependencies(),
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe(selected.action.target.measuredBytes);
    await expect(lstat(result.quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
    const markerPath = providerFilePurgeIsolationPath(
      selected.quarantineDirectory,
      manifest.entryId,
    );
    expect((await lstat(markerPath)).size).toBe(0);
  });

  it("ignores only the executor's own open descriptor", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-self-handle",
      entryId: "entry-self-handle",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: {
        ...idleDependencies(),
        inspectOpenHandles: async (path) => ({
          status: "busy" as const,
          matches: [{ pid: process.pid, source: "fd" as const, path }],
        }),
      },
    });

    await expect(readFile(result.quarantinePath, "utf8")).resolves.toBe("synthetic debug output\n");
  });

  it("restores source permissions when the provider becomes active", async () => {
    const selected = await fixture();
    const originalMode = (await lstat(selected.file)).mode;

    await expect(
      executeProviderFileQuarantine(selected.action, {
        runId: "run-active",
        entryId: "entry-active",
        quarantineDirectory: selected.quarantineDirectory,
        dependencies: {
          ...idleDependencies(),
          inspectProcesses: async () => ({ status: "busy" as const, pids: [123] }),
        },
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "PROVIDER_ACTIVE",
    });

    expect((await lstat(selected.file)).mode).toBe(originalMode);
    await expect(readFile(selected.file, "utf8")).resolves.toBe("synthetic debug output\n");
    await expect(
      readJsonFile(join(selected.quarantineDirectory, "entry-active.json")),
    ).resolves.toMatchObject({ status: "restored" });
  });

  it("keeps a preparing manifest when source permission repair fails", async () => {
    const selected = await fixture();
    let chmodCalls = 0;

    await expect(
      executeProviderFileQuarantine(selected.action, {
        runId: "run-mode-repair",
        entryId: "entry-mode-repair",
        quarantineDirectory: selected.quarantineDirectory,
        dependencies: {
          ...idleDependencies(),
          inspectProcesses: async () => ({ status: "busy" as const, pids: [123] }),
          chmodHandle: async (handle, mode) => {
            chmodCalls += 1;
            if (chmodCalls === 2) {
              throw new Error("synthetic chmod failure");
            }
            await handle.chmod(mode);
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "partially-applied",
      diagnosticCode: "PROVIDER_FILE_PERMISSION_RESTORE_FAILED",
    });

    const manifestPath = join(selected.quarantineDirectory, "entry-mode-repair.json");
    const manifest = providerFileQuarantineEntrySchema.parse(await readJsonFile(manifestPath));
    expect(manifest.status).toBe("preparing");
    expect((await lstat(selected.file)).mode).toBe(selected.action.target.mode & ~0o222);

    const recovered = await undoProviderFileQuarantine(manifest, {
      manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    expect(recovered.status).toBe("restored");
    expect((await lstat(selected.file)).mode).toBe(selected.action.target.mode);
  });

  it("refuses direct execution without an approved provider policy", async () => {
    const selected = await fixture();
    const { authorizeTarget: _authorizeTarget, ...dependencies } = idleDependencies();

    await expect(
      executeProviderFileQuarantine(selected.action, {
        runId: "run-policy",
        entryId: "entry-policy",
        quarantineDirectory: selected.quarantineDirectory,
        dependencies,
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "PROVIDER_FILE_POLICY_REFUSED",
    });
    await expect(readFile(selected.file, "utf8")).resolves.toBe("synthetic debug output\n");
  });

  it("does not chmod a symlink target raced into the source path", async () => {
    const selected = await fixture();
    const original = join(selected.action.target.ownerRoot, "debug", "original.txt");
    const protectedFile = join(selected.action.target.ownerRoot, "config.json");
    await writeFile(protectedFile, '{"token":"synthetic"}\n', { mode: 0o660 });
    const protectedMode = (await lstat(protectedFile)).mode;
    let authorized = false;

    await expect(
      executeProviderFileQuarantine(selected.action, {
        runId: "run-race",
        entryId: "entry-race",
        quarantineDirectory: selected.quarantineDirectory,
        dependencies: {
          ...idleDependencies(),
          authorizeTarget: async () => {
            if (!authorized) {
              authorized = true;
              await rename(selected.action.target.path, original);
              await symlink(protectedFile, selected.action.target.path);
            }
          },
        },
      }),
    ).rejects.toMatchObject({
      outcome: "failed",
    });

    expect((await lstat(protectedFile)).mode).toBe(protectedMode);
    await expect(readFile(protectedFile, "utf8")).resolves.toBe('{"token":"synthetic"}\n');
    await expect(
      readJsonFile(join(selected.quarantineDirectory, "entry-race.json")),
    ).resolves.toMatchObject({ status: "restored" });
  });

  it("rolls back when the source pathname changes before rename", async () => {
    const selected = await fixture();
    const rotated = join(selected.action.target.ownerRoot, "debug", "rotated.txt");
    const replacement = join(selected.action.target.ownerRoot, "debug", "replacement.txt");
    await writeFile(replacement, "replacement\n");
    let firstMove = true;
    const move = async (source: string, destination: string) => {
      if (firstMove) {
        firstMove = false;
        await rename(source, rotated);
        await rename(replacement, source);
      }
      await rename(source, destination);
    };

    await expect(
      executeProviderFileQuarantine(selected.action, {
        runId: "run-rename-race",
        entryId: "entry-rename-race",
        quarantineDirectory: selected.quarantineDirectory,
        dependencies: { ...idleDependencies(), move },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      diagnosticCode: "PROVIDER_FILE_UNEXPECTED_INODE_ROLLED_BACK",
    });

    await expect(readFile(selected.action.target.path, "utf8")).resolves.toBe("replacement\n");
    await expect(readFile(rotated, "utf8")).resolves.toBe("synthetic debug output\n");
    await expect(
      lstat(providerFileQuarantinePath(selected.quarantineDirectory, "entry-rename-race")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readJsonFile(join(selected.quarantineDirectory, "entry-rename-race.json")),
    ).resolves.toMatchObject({ status: "restored" });
  });

  it("rejects content changed after planning", async () => {
    const selected = await fixture();
    await writeFile(selected.file, "changed after planning\n");

    await expect(
      executeProviderFileQuarantine(selected.action, {
        runId: "run-stale",
        entryId: "entry-stale",
        quarantineDirectory: selected.quarantineDirectory,
        dependencies: idleDependencies(),
      }),
    ).rejects.toMatchObject({
      outcome: "skipped-stale",
      diagnosticCode: "PROVIDER_FILE_IDENTITY_CHANGED",
    });
    await expect(readFile(selected.file, "utf8")).resolves.toBe("changed after planning\n");
  });

  it("recovers a move completed before the manifest advanced", async () => {
    const selected = await fixture();
    await mkdir(selected.quarantineDirectory, { recursive: true });
    const entryId = "entry-interrupted";
    const quarantinePath = providerFileQuarantinePath(selected.quarantineDirectory, entryId);
    const manifestPath = join(selected.quarantineDirectory, `${entryId}.json`);
    const entry: ProviderFileQuarantineEntry = {
      schemaVersion: 1,
      entryId,
      runId: "run-interrupted",
      actionId: selected.action.actionId,
      resourceId: selected.action.resourceId,
      policyId: selected.action.policyId,
      status: "preparing",
      originalPath: selected.action.target.path,
      quarantinePath,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      target: selected.action.target,
    };
    await writeJsonAtomic(manifestPath, entry, {
      privateDirectories: [selected.quarantineDirectory],
    });
    await chmod(selected.action.target.path, selected.action.target.mode & ~0o222);
    await rename(selected.action.target.path, quarantinePath);

    const restored = await undoProviderFileQuarantine(entry, {
      manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });

    expect(restored.status).toBe("restored");
    await expect(readFile(selected.file, "utf8")).resolves.toBe("synthetic debug output\n");
  });

  it("keeps restored content sealed until its identity is verified", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-sealed-restore",
      entryId: "entry-sealed-restore",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    let observedMode: number | undefined;

    const restored = await undoProviderFileQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: {
        ...idleDependencies(),
        move: async (source, destination) => {
          await rename(source, destination);
          observedMode = (await lstat(destination)).mode;
        },
      },
    });

    expect(observedMode).toBe(selected.action.target.mode & ~0o222);
    expect(restored.status).toBe("restored");
    expect((await lstat(selected.file)).mode).toBe(selected.action.target.mode);
  });

  it("never follows a symlink presented as a provider file", async () => {
    const selected = await fixture();
    const external = join(await mkdtemp(join(tmpdir(), "agentrinse-provider-external-")), "log");
    await writeFile(external, "external\n");
    const linked = join(selected.ownerRoot, "debug", "linked.txt");
    await symlink(external, linked);

    await expect(inspectProviderFile(linked, selected.ownerRoot, "claude")).rejects.toThrow(
      "contains a symlink",
    );
  });

  it("never follows an internal symlink to neighboring provider state", async () => {
    const selected = await fixture();
    const config = join(selected.ownerRoot, "config.json");
    await writeFile(config, '{"token":"synthetic"}\n');
    const linked = join(selected.ownerRoot, "debug", "redirected.txt");
    await symlink(config, linked);

    await expect(inspectProviderFile(linked, selected.ownerRoot, "claude")).rejects.toThrow(
      "contains a symlink",
    );
    await expect(readFile(config, "utf8")).resolves.toBe('{"token":"synthetic"}\n');
  });

  it("rejects provider files with hard-link aliases", async () => {
    const selected = await fixture();
    const alias = join(selected.action.target.ownerRoot, "debug", "alias.txt");
    await link(selected.action.target.path, alias);

    await expect(
      inspectProviderFile(selected.action.target.path, selected.action.target.ownerRoot, "claude"),
    ).rejects.toThrow("multiple hard links");
    await expect(readFile(alias, "utf8")).resolves.toBe("synthetic debug output\n");
  });

  it.runIf(["darwin", "linux"].includes(process.platform))(
    "rejects a FIFO without blocking on open",
    async () => {
      const selected = await fixture();
      const fifo = join(selected.ownerRoot, "debug", "raced-fifo");
      await execFileAsync("mkfifo", [fifo]);

      await expect(inspectProviderFile(fifo, selected.ownerRoot, "claude")).rejects.toThrow(
        "not a regular file",
      );
    },
  );

  it("refuses purge while the payload has an open descriptor", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-open",
      entryId: "entry-open",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );

    await expect(
      purgeProviderFileQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory: selected.quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          ...idleDependencies(),
          inspectOpenHandles: async () => ({
            status: "busy" as const,
            matches: [{ pid: 123, source: "fd" as const, path: result.quarantinePath }],
          }),
        },
      }),
    ).rejects.toThrow("open");
    await expect(readFile(result.quarantinePath, "utf8")).resolves.toBe("synthetic debug output\n");
  });

  it("resumes purge from its deterministic private claim path", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-resume-purge",
      entryId: "entry-resume-purge",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    const isolationPath = providerFilePurgeIsolationPath(
      selected.quarantineDirectory,
      manifest.entryId,
    );
    await chmod(result.quarantinePath, selected.action.target.mode & ~0o222);
    await rename(result.quarantinePath, isolationPath);
    if (manifest.quarantineIdentity === undefined) {
      throw new Error("expected quarantined provider-file identity");
    }
    const purgingEntry = providerFileQuarantineEntrySchema.parse({
      ...manifest,
      status: "purging",
      quarantineIdentity: manifest.quarantineIdentity,
    });
    await writeJsonAtomic(result.manifestPath, purgingEntry, {
      privateDirectories: [selected.quarantineDirectory],
    });

    const purged = await purgeProviderFileQuarantine(purgingEntry, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      allowUnexpired: true,
      dependencies: idleDependencies(),
    });

    expect(purged.entry.status).toBe("purged");
    expect((await lstat(isolationPath)).size).toBe(0);
  });

  it("finalizes a purge interrupted after descriptor truncation", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-resume-truncated-purge",
      entryId: "entry-resume-truncated-purge",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    const isolationPath = providerFilePurgeIsolationPath(
      selected.quarantineDirectory,
      manifest.entryId,
    );
    await rename(result.quarantinePath, isolationPath);
    await truncate(isolationPath, 0);
    await chmod(isolationPath, selected.action.target.mode & ~0o222);
    if (manifest.quarantineIdentity === undefined) {
      throw new Error("expected quarantined provider-file identity");
    }
    const purgingEntry = providerFileQuarantineEntrySchema.parse({
      ...manifest,
      status: "purging",
      quarantineIdentity: manifest.quarantineIdentity,
    });
    await writeJsonAtomic(result.manifestPath, purgingEntry, {
      privateDirectories: [selected.quarantineDirectory],
    });

    const purged = await purgeProviderFileQuarantine(purgingEntry, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      allowUnexpired: true,
      dependencies: idleDependencies(),
    });

    expect(purged.entry.status).toBe("purged");
    expect(purged.reclaimedBytes).toBe(0);
    expect((await lstat(isolationPath)).size).toBe(0);
  });

  it("rolls back an unexpected inode raced into the purge claim", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-purge-race",
      entryId: "entry-purge-race",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    const heldPayload = join(selected.quarantineDirectory, "held-payload");
    const replacement = join(selected.quarantineDirectory, "replacement-payload");
    await writeFile(replacement, "replacement payload\n");
    let firstMove = true;
    const move = async (source: string, destination: string) => {
      if (firstMove) {
        firstMove = false;
        await rename(source, heldPayload);
        await rename(replacement, source);
      }
      await rename(source, destination);
    };

    await expect(
      purgeProviderFileQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory: selected.quarantineDirectory,
        allowUnexpired: true,
        dependencies: { ...idleDependencies(), move },
      }),
    ).rejects.toThrow("unexpected inode was restored");

    await expect(readFile(result.quarantinePath, "utf8")).resolves.toBe("replacement payload\n");
    await expect(readFile(heldPayload, "utf8")).resolves.toBe("synthetic debug output\n");
    await expect(
      lstat(providerFilePurgeIsolationPath(selected.quarantineDirectory, manifest.entryId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never truncates a replacement raced into the private purge claim", async () => {
    const selected = await fixture();
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-truncate-race",
      entryId: "entry-truncate-race",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    const isolationPath = providerFilePurgeIsolationPath(
      selected.quarantineDirectory,
      manifest.entryId,
    );
    const heldPayload = join(selected.quarantineDirectory, "held-truncate-payload");

    await expect(
      purgeProviderFileQuarantine(manifest, {
        manifestPath: result.manifestPath,
        quarantineDirectory: selected.quarantineDirectory,
        allowUnexpired: true,
        dependencies: {
          ...idleDependencies(),
          truncateHandle: async (handle) => {
            await rename(isolationPath, heldPayload);
            await writeFile(isolationPath, "replacement payload\n");
            await handle.truncate(0);
          },
        },
      }),
    ).rejects.toThrow("marker");

    await expect(readFile(isolationPath, "utf8")).resolves.toBe("replacement payload\n");
    expect((await lstat(heldPayload)).size).toBe(0);
  });

  it("purges an owner-read-only payload through a validated writable descriptor", async () => {
    const selected = await fixture();
    await chmod(selected.file, 0o440);
    const target = await inspectProviderFile(selected.file, selected.ownerRoot, "claude");
    selected.action = {
      ...selected.action,
      pendingQuarantineBytes: target.measuredBytes,
      target,
    };
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-read-only-purge",
      entryId: "entry-read-only-purge",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );

    const purged = await purgeProviderFileQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      allowUnexpired: true,
      dependencies: idleDependencies(),
    });

    expect(purged.entry.status).toBe("purged");
    const markerPath = providerFilePurgeIsolationPath(
      selected.quarantineDirectory,
      manifest.entryId,
    );
    expect((await lstat(markerPath)).size).toBe(0);
  });

  it("preserves non-write permission bits across quarantine and undo", async () => {
    const selected = await fixture();
    await chmod(selected.file, 0o4750);
    const target = await inspectProviderFile(selected.file, selected.ownerRoot, "claude");
    selected.action = {
      ...selected.action,
      pendingQuarantineBytes: target.measuredBytes,
      target,
    };
    const result = await executeProviderFileQuarantine(selected.action, {
      runId: "run-mode",
      entryId: "entry-mode",
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    const manifest = providerFileQuarantineEntrySchema.parse(
      await readJsonFile(result.manifestPath),
    );
    await undoProviderFileQuarantine(manifest, {
      manifestPath: result.manifestPath,
      quarantineDirectory: selected.quarantineDirectory,
      dependencies: idleDependencies(),
    });
    expect((await lstat(selected.file)).mode).toBe(target.mode);
  });
});
