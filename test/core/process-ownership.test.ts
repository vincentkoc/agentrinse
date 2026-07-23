import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findProcessesUsingPath } from "../../src/core/process-ownership.js";

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
});
