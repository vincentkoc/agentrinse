import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, loadConfigForHome } from "../../src/config/load.js";

describe("loadConfig", () => {
  it("returns isolated defaults", async () => {
    const first = await loadConfig();
    first.adapters.codex = { enabled: false };

    const second = await loadConfig();
    expect(second.adapters.codex).toEqual({ enabled: true });
  });

  it("loads the default home config when present", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const path = join(home, ".config", "agentrinse", "config.json");
    await mkdir(join(home, ".config", "agentrinse"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        audit: { measureBytes: false },
      }),
    );

    const loaded = await loadConfigForHome(home, undefined, {});
    expect(loaded.exists).toBe(true);
    expect(loaded.path).toBe(path);
    expect(loaded.config.audit.measureBytes).toBe(false);
  });

  it("uses safe defaults when the default home config is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const loaded = await loadConfigForHome(home, undefined, {});

    expect(loaded.exists).toBe(false);
    expect(loaded.config.artifacts.projects).toEqual([]);
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
        pins: [
          { path: "/tmp/project" },
          { resourceId: "git:git-worktree:fixture" },
          { gitRef: "refs/heads/release", expiresAt: "2026-08-01T00:00:00.000Z" },
        ],
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
    expect(config.pins).toEqual([
      { path: "/tmp/project" },
      { resourceId: "git:git-worktree:fixture" },
      { gitRef: "refs/heads/release", expiresAt: "2026-08-01T00:00:00.000Z" },
    ]);
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

  it("rejects duplicate and overlapping artifact scopes", async () => {
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
              names: ["node_modules"],
            },
            {
              root: "/tmp/project",
              names: ["dist"],
            },
            {
              root: "/tmp/project/node_modules/package",
              names: ["dist"],
            },
          ],
        },
      }),
    );

    await expect(loadConfig(path)).rejects.toThrow(
      /artifact project roots must be unique|artifact cleanup targets must not overlap/,
    );
  });

  it("rejects ambiguous, relative, and malformed pins", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        pins: [{ path: "./project" }, { path: "/tmp/project", resourceId: "resource" }],
      }),
    );

    await expect(loadConfig(path)).rejects.toThrow();
  });

  it.each([
    "refs/tags/",
    "refs/heads/foo bar",
    "refs/heads/foo..bar",
    "refs/heads/foo.lock",
    "refs/heads/.hidden",
    "refs/heads/foo@{bar",
    "refs/heads/foo.",
    "refs/heads/foo//bar",
    "refs/heads/foo~1",
  ])("rejects invalid Git pin ref %s", async (gitRef) => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-"));
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        pins: [{ gitRef }],
      }),
    );

    await expect(loadConfig(path)).rejects.toThrow("pin Git ref is invalid");
  });
});
