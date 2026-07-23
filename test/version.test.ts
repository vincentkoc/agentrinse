import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

describe("package version", () => {
  it("matches the CLI version", async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson).toMatchObject({ version: VERSION });
  });
});
