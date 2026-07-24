import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executeConfigInitCommand,
  executeConfigPathCommand,
  executeConfigShowCommand,
  executeConfigValidateCommand,
} from "../../src/commands/config.js";

describe("config commands", () => {
  it("resolves, initializes, shows, and validates the default path", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-config-command-"));
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
    const home = await mkdtemp(join(tmpdir(), "agentrinse-config-command-"));
    await executeConfigInitCommand({ home, environment: {} });

    await expect(executeConfigInitCommand({ home, environment: {} })).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("shows safe defaults when the default path does not exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-config-command-"));
    const shown = await executeConfigShowCommand({ home, environment: {} });

    expect(shown.config).toMatchObject({
      schemaVersion: 1,
      artifacts: { projects: [] },
    });
  });
});
