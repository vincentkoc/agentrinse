import { describe, expect, it } from "vitest";

import { buildProgram } from "../src/main.js";

describe("clean CLI", () => {
  it("rejects repository inputs for the default closeout profile", async () => {
    const program = buildProgram().exitOverride();

    await expect(
      program.parseAsync(
        ["node", "agentrinse", "clean", "--repo", "/tmp/repo", "--apply", "--yes"],
        { from: "node" },
      ),
    ).rejects.toThrow("clean --profile closeout does not accept --repo; use --profile fleet");
  });
});
