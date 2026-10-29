import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeAuditAdapter } from "../../src/adapters/runtime/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const readdirMock = vi.mocked(fs.readdir);
const lstatMock = vi.mocked(fs.lstat);

function errnoError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });
}

/**
 * Model a version file removed while the directory is being listed: the
 * filesystem still returns its name, reports its type as unknown, and the
 * file is gone by the time anything lstat()s it. With `withFileTypes`, Node
 * performs that lstat inside readdir, so the whole listing rejects.
 */
function simulateVanishingEntry(versions: string, name: string): void {
  const vanished = join(versions, name);
  readdirMock.mockImplementation((async (path: string, options?: unknown) => {
    if (path === versions) {
      if (typeof options === "object" && options !== null && "withFileTypes" in options) {
        throw errnoError("ENOENT", "lstat", vanished);
      }
      return [name, ...(await actualFs.readdir(versions))];
    }
    return actualFs.readdir(path, options as never);
  }) as never);
}

async function claudeVersions(): Promise<{ context: AuditContext; versions: string }> {
  const context: AuditContext = {
    home: await mkdtemp(join(tmpdir(), "agentrinse-runtime-race-")),
    now: new Date("2026-07-24T00:00:00.000Z"),
    auditId: "audit-runtime-race",
  };
  const versions = join(context.home, ".local", "share", "claude", "versions");
  await mkdir(versions, { recursive: true });
  for (const version of ["2.1.200", "2.1.201"]) {
    await writeFile(join(versions, version), version);
    await chmod(join(versions, version), 0o700);
  }
  return { context, versions };
}

function adapter(): RuntimeAuditAdapter {
  return new RuntimeAuditAdapter({
    environment: { PATH: "/nonexistent-agentrinse-bin" },
    platform: "linux",
    runVersion: async () => {
      throw new Error("native Claude versions do not need execution");
    },
  });
}

async function collect(context: AuditContext) {
  const runtime = adapter();
  return runtime.collect(context, await runtime.probe(context));
}

afterEach(() => {
  readdirMock.mockImplementation(actualFs.readdir as never);
  lstatMock.mockImplementation(actualFs.lstat as never);
});

describe("Claude native version listing", () => {
  it("skips a version removed mid-listing and keeps the rest", async () => {
    const { context, versions } = await claudeVersions();
    simulateVanishingEntry(versions, "2.1.199");

    const collection = await collect(context);

    expect(collection.resources.map((resource) => resource.facts.version).sort()).toEqual([
      "2.1.200",
      "2.1.201",
    ]);
    expect(collection.diagnostics).toEqual([]);
  });

  it("still ignores directories and symlinks in the version root", async () => {
    const { context, versions } = await claudeVersions();
    await mkdir(join(versions, "not-a-version"));
    await symlink(join(versions, "2.1.201"), join(versions, "latest"));

    const collection = await collect(context);

    expect(collection.resources.map((resource) => resource.facts.version).sort()).toEqual([
      "2.1.200",
      "2.1.201",
    ]);
  });

  it("fails closed with a diagnostic when an entry cannot be inspected", async () => {
    const { context, versions } = await claudeVersions();
    const blocked = join(versions, "2.1.201");
    lstatMock.mockImplementation((async (path: string, ...rest: unknown[]) => {
      if (path === blocked) {
        throw errnoError("EACCES", "lstat", blocked);
      }
      return actualFs.lstat(path, ...(rest as [never]));
    }) as never);

    const collection = await collect(context);

    expect(collection.diagnostics).toEqual([
      expect.objectContaining({ code: "CLAUDE_RUNTIME_INSPECTION_FAILED", severity: "warning" }),
    ]);
  });
});
