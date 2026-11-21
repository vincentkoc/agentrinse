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

  it("distinguishes OpenClaw owners from tools reviewing the repository", async () => {
    const processes = [
      "401 openclaw-gateway",
      "402 /usr/bin/node /opt/node_modules/openclaw/openclaw.mjs agent",
      "403 /Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
      "404 node review.js --target-repo /project/openclaw --target-dir /tmp/checks",
      "405 bash stage-runtime.sh /staging/OpenClaw.app/Contents/Resources",
    ];
    expect(
      await inspectProviderProcesses("openclaw", { runPs: async () => processes.join("\n") }),
    ).toEqual({ status: "busy", pids: [401, 402, 403] });
  });

  it("reports idle only after parsing a complete nonmatching process list", async () => {
    await expect(
      inspectProviderProcesses("grok", {
        runPs: async () => "  301 /usr/bin/ssh host\n  302 /usr/bin/git status\n",
      }),
    ).resolves.toEqual({ status: "idle", pids: [] });
  });
});
