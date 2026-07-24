import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readJsonFile, writeJsonAtomic, writeJsonExclusive } from "../../src/state/json-file.js";

describe("atomic JSON files", () => {
  it("writes a complete owner-only document", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-state-"));
    const path = join(root, "plans", "plan.json");

    await writeJsonAtomic(path, { planId: "plan-1" });

    expect(await readJsonFile(path)).toEqual({ planId: "plan-1" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "plans"))).mode & 0o777).toBe(0o700);
  });

  it("does not change permissions on an existing parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-parent-"));
    await chmod(root, 0o755);

    await writeJsonExclusive(join(root, "config.json"), { schemaVersion: 1 });

    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(join(root, "config.json"))).mode & 0o777).toBe(0o600);
  });

  it("repairs and verifies AgentRinse-owned state directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-private-state-"));
    const plans = join(root, "plans");
    await chmod(root, 0o777);

    await writeJsonAtomic(
      join(plans, "plan.json"),
      { planId: "plan-1" },
      {
        privateDirectories: [root, plans],
      },
    );

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(plans)).mode & 0o777).toBe(0o700);
  });
});
