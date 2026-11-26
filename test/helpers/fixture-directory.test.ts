import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOwnedFixture } from "../../scripts/owned-fixture.mjs";
import { createFixtureDirectory } from "./fixture-directory.js";

it.each([0, 1])("removes only the current script's fixture on exit %i", (code) => {
  const parent = createFixtureDirectory(join(tmpdir(), "agentrinse-lifetime-"));
  const sentinel = join(parent, "agentrinse-old");
  mkdirSync(sentinel);
  const module = new URL("../../scripts/owned-fixture.mjs", import.meta.url);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {createScriptFixture} from " +
        JSON.stringify(module.href) +
        "; console.log(createScriptFixture(process.argv[1]));process.exitCode=" +
        code,
      join(parent, "agentrinse-"),
    ],
    { encoding: "utf8" },
  );
  expect(child.status).toBe(code);
  expect(child.stdout.trim()).toMatch(/agentrinse-/u);
  expect(existsSync(child.stdout.trim())).toBe(false);
  expect(existsSync(sentinel)).toBe(true);
});

it("retains a replaced directory with the same name", () => {
  const parent = createFixtureDirectory(join(tmpdir(), "agentrinse-lifetime-"));
  const original = createOwnedFixture(join(parent, "entry-"));
  renameSync(original.path, original.path + "-moved");
  mkdirSync(original.path);
  writeFileSync(join(original.path, "sentinel"), "keep");
  expect(() => original.dispose()).toThrow("replaced");
  expect(existsSync(join(original.path, "sentinel"))).toBe(true);
});
