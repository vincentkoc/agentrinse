import { readFile, writeFile } from "node:fs/promises";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeConfigInitCommand,
  executeConfigRenderCommand,
  executeConfigPolicyCommand,
  executeConfigPathCommand,
  executeConfigShowCommand,
  executeConfigValidateCommand,
} from "../../src/commands/config.js";

describe("config commands", () => {
  it("resolves, initializes, shows, and validates the default path", async () => {
    const home = createFixtureDirectory(join(tmpdir(), "agentrinse-config-command-"));
    const expectedPath = join(home, ".config", "agentrinse", "config.json");

    expect(executeConfigPathCommand({ home, environment: {} }).path).toBe(expectedPath);

    const initialized = await executeConfigInitCommand({ home, environment: {} });
    expect(initialized.path).toBe(expectedPath);
    expect(initialized.output).toBe(`created ${expectedPath}\n`);

    const stored = JSON.parse(await readFile(expectedPath, "utf8"));
    expect(stored).toMatchObject({
      schemaVersion: 1,
      artifacts: { projects: [] },
    });

    const shown = await executeConfigShowCommand({ home, environment: {} });
    expect(shown.config).toEqual(stored);
    expect(JSON.parse(shown.output)).toEqual(stored);

    const validated = await executeConfigValidateCommand({ home, environment: {} });
    expect(validated.output).toBe(`valid ${expectedPath}\n`);
  });

  it("never overwrites an existing config", async () => {
    const home = createFixtureDirectory(join(tmpdir(), "agentrinse-config-command-"));
    await executeConfigInitCommand({ home, environment: {} });

    await expect(executeConfigInitCommand({ home, environment: {} })).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("shows safe defaults when the default path does not exist", async () => {
    const home = createFixtureDirectory(join(tmpdir(), "agentrinse-config-command-"));
    const shown = await executeConfigShowCommand({ home, environment: {} });

    expect(shown.config).toMatchObject({
      schemaVersion: 1,
      artifacts: { projects: [] },
    });
  });
});

it("renders repeated typed overrides as a reusable profile and lists the effective rule floors", async () => {
  const home = createFixtureDirectory(join(tmpdir(), "agentrinse-profile-"));
  const options = { home, environment: {} };
  const profile = await executeConfigRenderCommand(options, [
    "/worktrees/minAgeMinutes=4320",
    "/providerRules/claude.changelog-cache/enabled=false",
    "/artifacts/byName/.next/minBytes=4096",
    '/storage/rules=["npm.content","apple.system-updates"]',
  ]);
  const config = join(home, "profile.json");
  await writeFile(config, profile);
  expect(
    (await executeConfigValidateCommand({ ...options, config })).config?.worktrees.minAgeMinutes,
  ).toBe(4320);
  const policy = JSON.parse(await executeConfigPolicyCommand({ ...options, config }));
  expect(policy.providerRules).toContainEqual(
    expect.objectContaining({
      id: "claude.changelog-cache",
      effective: expect.objectContaining({ enabled: false }),
      floor: expect.objectContaining({ minAgeMinutes: 43200 }),
    }),
  );
  expect(policy.artifacts).toContainEqual(
    expect.objectContaining({
      name: ".next",
      effective: expect.objectContaining({ minBytes: 4096 }),
    }),
  );
  expect(await executeConfigRenderCommand({ ...options, config }, [])).toBe(profile);
});

it.each([
  '/audit={"notAnOption":true}',
  "/audit/notAnOption=true",
  "/unknown=true",
  "/artifacts/processCheck=false",
  "/providerRules/unknown.rule/enabled=false",
  "/providerRules/claude.debug-log/minAgeMinutes=0",
  "/storage/reviewAgeMinutes/npm.content=5",
  '/storage/rules=["not.registered"]',
  "/artifacts/byName/*/enabled=true",
  "/worktrees/minAgeMinutes=false",
  "/__proto__/injected=true",
  "/constructor/prototype/injected=true",
  "/plan/maxRisk=no-json",
])("rejects unsupported fields, values or policy floors: %s", async (assignment) => {
  const home = createFixtureDirectory(join(tmpdir(), "agentrinse-invalid-profile-"));
  await expect(
    executeConfigRenderCommand({ home, environment: {} }, [assignment]),
  ).rejects.toThrow();
});

it("reads version-one extensions in legacy fields without permitting new rule typos", async () => {
  const home = createFixtureDirectory(join(tmpdir(), "agentrinse-legacy-policy-"));
  const config = join(home, "config.json");
  await writeFile(
    config,
    JSON.stringify({ schemaVersion: 1, legacyExtension: "ignored", audit: { legacyBudget: 1 } }),
  );
  const value = await executeConfigValidateCommand({ home, config });
  expect(value.config).not.toHaveProperty("legacyExtension");
  expect(value.config?.audit).not.toHaveProperty("legacyBudget");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, storage: { family: ["developer"] } }));
  await expect(executeConfigValidateCommand({ home, config })).rejects.toThrow();
});
