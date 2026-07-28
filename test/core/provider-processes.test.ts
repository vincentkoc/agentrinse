import { describe, expect, it } from "vitest";

import {
  inspectProviderProcesses,
  providerProcessListArguments,
} from "../../src/core/provider-processes.js";

describe("provider process inspection", () => {
  it("requests untruncated process command lines", () => {
    expect(providerProcessListArguments()).toContain("-ww");
  });

  it("detects a provider launched through an interpreter", async () => {
    await expect(
      inspectProviderProcesses("claude", {
        runPs: async () =>
          [
            "  101 /usr/bin/node /opt/node_modules/@anthropic-ai/claude-code/cli.js",
            "  102 /usr/bin/python worker.py",
          ].join("\n"),
      }),
    ).resolves.toEqual({ status: "busy", pids: [101] });
  });

  it("detects native application and helper processes", async () => {
    await expect(
      inspectProviderProcesses("cursor", {
        runPs: async () =>
          [
            "  201 /Applications/Cursor.app/Contents/MacOS/Cursor",
            "  202 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper",
          ].join("\n"),
      }),
    ).resolves.toEqual({ status: "busy", pids: [201, 202] });
  });

  it("detects Zed application and headless processes", async () => {
    await expect(
      inspectProviderProcesses("zed", {
        runPs: async () =>
          [
            "  211 /Applications/Zed.app/Contents/MacOS/zed",
            "  212 /usr/local/bin/zed-editor --headless",
          ].join("\n"),
      }),
    ).resolves.toEqual({ status: "busy", pids: [211, 212] });
  });

  it("fails closed on incomplete process evidence", async () => {
    await expect(
      inspectProviderProcesses("opencode", {
        runPs: async () => "not-a-process-record",
      }),
    ).resolves.toMatchObject({ status: "unknown" });
  });

  it("reports idle only after parsing a complete nonmatching process list", async () => {
    await expect(
      inspectProviderProcesses("grok", {
        runPs: async () => "  301 /usr/bin/ssh host\n  302 /usr/bin/git status\n",
      }),
    ).resolves.toEqual({ status: "idle", pids: [] });
  });
});
