import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  undoProviderFileQuarantine,
} from "../../src/core/provider-file-recovery.js";
import { writeJsonAtomic, readJsonFile } from "../../src/state/json-file.js";

const NOW = new Date("2026-07-25T00:00:00.000Z");

function idleDependencies() {
  return {
    clock: () => NOW,
    move: rename,
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
