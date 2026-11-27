import { link, mkdir, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executePrGcDiff } from "../../src/commands/openclaw-pr-gc-diff.js";
import { parseStorageMounts } from "../../src/core/storage-mounts.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";

it.skipIf(process.platform === "win32")(
  "reads only bounded literal local GC logs and redacts their locations",
  async () => {
    const root = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-gc-log-")));
    const options = {
      repo: join(root, "owner"),
      preview: join(root, "before"),
      applyLog: join(root, "after"),
      json: true,
    };
    const readMounts = async () =>
      parseStorageMounts("linux", "1 0 8:1 / / rw - ext4 /dev/example rw");
    await writeFile(options.preview, "would remove .worktrees/pr-1 (PR #1 state=MERGED)\n");
    await writeFile(options.applyLog, "removed .worktrees/pr-2 (PR #2 state=MERGED)\n");
    const output = await executePrGcDiff(options, readMounts);
    expect(JSON.parse(output)).toMatchObject({
      command: "openclaw-pr-gc-diff",
      status: "degraded",
      data: { outsideAttempts: ["2"] },
    });
    expect(output).not.toContain(root);
    await symlink(options.preview, join(root, "alias"));
    await mkdir(join(root, "sessions"));
    await writeFile(join(root, "sessions", "log"), "");
    for (const path of [join(root, "alias"), root, join(root, "sessions", "log")]) {
      await expect(executePrGcDiff({ ...options, preview: path }, readMounts)).rejects.toThrow();
    }
    await truncate(options.applyLog, (4 << 20) + 1);
    await expect(executePrGcDiff(options, readMounts)).rejects.toThrow("4 MiB");
    await link(options.preview, join(root, "second-link"));
    await expect(executePrGcDiff(options, readMounts)).rejects.toThrow("single-link");
  },
);
