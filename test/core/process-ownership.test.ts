import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProcessOwnershipProbe,
  findProcessesUsingFile,
  findProcessesUsingPath,
} from "../../src/core/process-ownership.js";

async function fakeProcess(
  procRoot: string,
  pid: number,
  uid: number,
  cwd: string,
  descriptors: string[] = [],
): Promise<void> {
  const root = join(procRoot, String(pid));
  await mkdir(join(root, "fd"), { recursive: true });
  await writeFile(join(root, "status"), `Name:\tfixture\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  await symlink(cwd, join(root, "cwd"));
  for (const [index, path] of descriptors.entries()) {
    await symlink(path, join(root, "fd", String(index)));
  }
}

describe("findProcessesUsingPath", () => {
  it("finds same-user cwd and file descriptor ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-proc-"));
    const procRoot = join(root, "proc");
    const target = join(root, "project", "node_modules");
    await mkdir(target, { recursive: true });
    await fakeProcess(procRoot, 101, 501, target, [join(target, "package.json")]);

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
    });

    expect(result.status).toBe("busy");
    expect(result.matches).toEqual([
      { pid: 101, source: "cwd", path: target },
      {
        pid: 101,
        source: "fd",
        path: join(target, "package.json"),
      },
    ]);
  });

  it("ignores processes owned by other users", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-proc-"));
    const procRoot = join(root, "proc");
    const target = join(root, "project", "dist");
    await mkdir(target, { recursive: true });
    await fakeProcess(procRoot, 202, 999, target);

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
    });

    expect(result).toEqual({ status: "idle", matches: [] });
  });

  it("uses lsof when hardened procfs blocks a same-user process scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-proc-"));
    const procRoot = join(root, "proc");
    const processRoot = join(procRoot, "303");
    const target = join(root, "project", "build");
    await mkdir(join(processRoot, "fd"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(processRoot, "status"), "Name:\tfixture\nUid:\t501\t501\t501\t501\n");
    await writeFile(join(processRoot, "cwd"), "not a symlink");

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
      runLsof: async () => ({ stdout: "", stderr: "" }),
    });

    expect(result).toEqual({ status: "idle", matches: [] });
  });

  it("keeps Linux process ownership unknown when lsof fallback is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-proc-"));
    const procRoot = join(root, "proc");
    const processRoot = join(procRoot, "404");
    const target = join(root, "project", "build");
    await mkdir(join(processRoot, "fd"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(processRoot, "status"), "Name:\tfixture\nUid:\t501\t501\t501\t501\n");
    await writeFile(join(processRoot, "cwd"), "not a symlink");

    const result = await findProcessesUsingPath(target, {
      platform: "linux",
      procRoot,
      uid: 501,
      runLsof: async () => ({ stdout: "", stderr: "permission denied" }),
    });

    expect(result).toMatchObject({ status: "unknown" });
  });

  it("fails closed on unsupported platforms", async () => {
    const result = await findProcessesUsingPath("/tmp/fixture", {
      platform: "win32",
    });

    expect(result.status).toBe("unknown");
  });

  it("treats macOS lsof exit status 1 with no output as idle", async () => {
    await expect(
      findProcessesUsingPath("/tmp/fixture", {
        platform: "darwin",
        runLsof: async () => {
          throw { code: 1, stdout: "", stderr: "" };
        },
      }),
    ).resolves.toEqual({ status: "idle", matches: [] });
  });

  it("fails closed when macOS lsof reports an incomplete scan", async () => {
    await expect(
      findProcessesUsingPath("/tmp/fixture", {
        platform: "darwin",
        runLsof: async () => {
          throw {
            code: 1,
            stdout: "",
            stderr: "permission denied",
          };
        },
      }),
    ).resolves.toMatchObject({ status: "unknown" });
  });

  it("fails closed when the bounded lsof command times out", async () => {
    await expect(
      findProcessesUsingPath("/tmp/fixture", {
        platform: "darwin",
        runLsof: async () => {
          throw new Error("lsof timed out after 10000ms");
        },
      }),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "lsof timed out after 10000ms",
    });
  });

  it("parses NUL-delimited target-selected paths with spaces and newlines", async () => {
    const target = "/fixture/project build";
    const nested = `${target}/nested\noutput.log`;
    const stdout = `p42\0cnode\0\nfcwd\0n${target}\0\nf9\0n${nested}\0\n`;

    await expect(
      findProcessesUsingPath(target, {
        platform: "darwin",
        runLsof: async (selectedTarget, args) => {
          expect(selectedTarget).toBe(target);
          expect(args).toEqual(["-nP", "-F0pcfn", "+D", target]);
          return { stdout, stderr: "" };
        },
      }),
    ).resolves.toEqual({
      status: "busy",
      matches: [
        { pid: 42, source: "cwd", path: target },
        { pid: 42, source: "fd", path: nested },
      ],
    });
  });

  it("uses direct exact-file selection without textual path filtering", async () => {
    const target = "/fixture/state.sqlite";
    await expect(
      findProcessesUsingFile(target, {
        platform: "darwin",
        runLsof: async () => ({
          stdout: "p42\0ccodex\0\nf9\0n/fixture/hardlink-alias.sqlite\0\n",
          stderr: "",
        }),
      }),
    ).resolves.toEqual({
      status: "busy",
      matches: [{ pid: 42, source: "fd", path: "/fixture/hardlink-alias.sqlite" }],
    });
  });

  it("opens the audit-pass circuit after one incomplete macOS scan", async () => {
    let scans = 0;
    const probe = createProcessOwnershipProbe({
      platform: "darwin",
      runLsof: async () => {
        scans += 1;
        return { stdout: "", stderr: "permission denied" };
      },
    });

    await expect(probe("/fixture/one")).resolves.toMatchObject({
      status: "unknown",
      reason: "lsof reported an incomplete scan: permission denied",
    });
    await expect(probe("/fixture/two")).resolves.toMatchObject({
      status: "unknown",
      reason: "lsof reported an incomplete scan: permission denied",
    });
    expect(scans).toBe(1);
  });

  it("starts a fresh target-selected scan after successful audit probes", async () => {
    const targets: string[] = [];
    const probe = createProcessOwnershipProbe({
      platform: "darwin",
      runLsof: async (target) => {
        targets.push(target);
        return { stdout: "", stderr: "" };
      },
    });

    await expect(probe("/fixture/one")).resolves.toEqual({ status: "idle", matches: [] });
    await expect(probe("/fixture/two")).resolves.toEqual({ status: "idle", matches: [] });
    expect(targets).toEqual(["/fixture/one", "/fixture/two"]);
  });

  it("fails closed on malformed structured lsof output", async () => {
    await expect(
      findProcessesUsingPath("/fixture/project", {
        platform: "darwin",
        runLsof: async () => ({
          stdout: "n/fixture/project\0\n",
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "malformed lsof output: unowned path field",
    });
  });

  it("fails closed when the final lsof set has no newline terminator", async () => {
    await expect(
      findProcessesUsingPath("/fixture/project", {
        platform: "darwin",
        runLsof: async () => ({
          stdout: "p42\0cnode\0\nf9\0n/fixture/project/cache\0",
          stderr: "",
        }),
      }),
    ).resolves.toMatchObject({
      status: "unknown",
      reason: "malformed lsof output: unterminated set",
    });
  });

  it("preserves a literal lsof path ending in the deleted marker text", async () => {
    const target = "/fixture/cache (deleted)";
    await expect(
      findProcessesUsingFile(target, {
        platform: "darwin",
        runLsof: async () => ({
          stdout: `p42\0cnode\0\nf9\0n${target}\0\n`,
          stderr: "",
        }),
      }),
    ).resolves.toEqual({
      status: "busy",
      matches: [{ pid: 42, source: "fd", path: target }],
    });
  });
});
