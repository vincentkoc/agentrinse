import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readJsonFile, writeJsonAtomic } from "../../src/state/json-file.js";

describe("atomic JSON files", () => {
  it("writes a complete owner-only document", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-state-"));
    const path = join(root, "plans", "plan.json");

    await writeJsonAtomic(path, { planId: "plan-1" });

    expect(await readJsonFile(path)).toEqual({ planId: "plan-1" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
