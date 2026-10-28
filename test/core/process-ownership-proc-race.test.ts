import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findProcessesUsingPath } from "../../src/core/process-ownership.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const readdirMock = vi.mocked(fs.readdir);

const VANISHED_PID = "999";

/**
 * Model procfs while a process exits mid-scan: the kernel lists the PID with
 * DT_UNKNOWN, so `readdir({ withFileTypes: true })` lstat()s it and rejects
 * with ENOENT, while a names-only listing still includes the PID even though
 * its directory is already gone.
 */
function simulateExitingProcess(procRoot: string): void {
  readdirMock.mockImplementation((async (path: string, options?: unknown) => {
    if (path === procRoot) {
      if (typeof options === "object" && options !== null && "withFileTypes" in options) {
        const vanished = join(procRoot, VANISHED_PID);
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${vanished}'`), {
          code: "ENOENT",
          errno: -2,
          syscall: "lstat",
          path: vanished,
        });
      }
      return [...(await actualFs.readdir(procRoot)), VANISHED_PID];
    }
    return actualFs.readdir(path, options as never);
  }) as never);
}

async function fakeProcess(procRoot: string, pid: number, cwd: string): Promise<void> {
  const root = join(procRoot, String(pid));
  await mkdir(join(root, "fd"), { recursive: true });
  await writeFile(join(root, "status"), "Name:\tfixture\nUid:\t501\t501\t501\t501\n");
  await symlink(cwd, join(root, "cwd"));
}

async function fixture(): Promise<{ procRoot: string; target: string; elsewhere: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentrinse-proc-race-"));
  const procRoot = join(root, "proc");
  const target = join(root, "project", "build");
  const elsewhere = join(root, "elsewhere");
  await mkdir(target, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await mkdir(procRoot, { recursive: true });
  return { procRoot, target, elsewhere };
}

afterEach(() => {
  readdirMock.mockImplementation(actualFs.readdir as never);
});

describe("Linux process scan when a process exits mid-scan", () => {
  it("skips the vanished PID and still reports a live owner", async () => {
    const { procRoot, target } = await fixture();
    await fakeProcess(procRoot, 101, target);
    simulateExitingProcess(procRoot);
    const runLsof = vi.fn(async () => ({ stdout: "", stderr: "" }));

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
      runLsof,
    });

    expect(result).toEqual({
      status: "busy",
      matches: [{ pid: 101, source: "cwd", path: target }],
    });
    expect(runLsof).not.toHaveBeenCalled();
  });

  it("reports idle without an lsof fallback when only the vanished PID was unreadable", async () => {
    const { procRoot, target, elsewhere } = await fixture();
    await fakeProcess(procRoot, 102, elsewhere);
    simulateExitingProcess(procRoot);
    const runLsof = vi.fn(async () => ({ stdout: "", stderr: "" }));

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
      runLsof,
    });

    expect(result).toEqual({ status: "idle", matches: [] });
    expect(runLsof).not.toHaveBeenCalled();
  });

  it("still fails closed when a numeric entry is not a readable process directory", async () => {
    const { procRoot, target } = await fixture();
    await writeFile(join(procRoot, "103"), "not a process directory");
    simulateExitingProcess(procRoot);
    const runLsof = vi.fn(async () => ({ stdout: "", stderr: "permission denied" }));

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
      runLsof,
    });

    expect(runLsof).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "unknown" });
  });
});
