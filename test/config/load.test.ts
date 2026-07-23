import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";

describe("loadConfig", () => {
  it("returns isolated defaults", async () => {
    const first = await loadConfig();
    first.adapters.codex = { enabled: false };

    const second = await loadConfig();
    expect(second.adapters.codex).toEqual({ enabled: true });
  });

  it("merges a partial config over defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        adapters: {
          opencode: { enabled: false },
        },
        audit: {
          measureBytes: false,
        },
        artifacts: {
          projects: [
            {
              root: "/tmp/project",
              names: ["node_modules", "dist"],
            },
          ],
          minBytes: 1,
        },
      }),
    );

    const config = await loadConfig(path);
    expect(config.adapters.opencode).toEqual({ enabled: false });
    expect(config.adapters.codex).toEqual({ enabled: true });
    expect(config.audit).toEqual({
      maxEntries: 100_000,
      measureBytes: false,
    });
    expect(config.artifacts.projects).toEqual([
      {
        root: "/tmp/project",
        names: ["node_modules", "dist"],
      },
    ]);
    expect(config.artifacts.minAgeMinutes).toBe(24 * 60);
    expect(config.artifacts.minBytes).toBe(1);
  });

  it("rejects relative artifact roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        artifacts: {
          projects: [{ root: "./project", names: ["node_modules"] }],
        },
      }),
    );

    await expect(loadConfig(path)).rejects.toThrow("artifact project root must be absolute");
  });

  it("rejects duplicate artifact names", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        artifacts: {
          projects: [
            {
              root: "/tmp/project",
              names: ["dist", "dist"],
            },
          ],
        },
      }),
    );

    await expect(loadConfig(path)).rejects.toThrow("artifact names must be unique");
  });
});
