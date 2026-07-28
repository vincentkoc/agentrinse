import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ProviderFileQuarantineAction } from "../../src/contracts/action.js";
import { inspectProviderFile } from "../../src/core/provider-file-identity.js";
import {
  authorizeProviderFileAction,
  CLAUDE_CHANGELOG_CACHE_POLICY_ID,
  CLAUDE_DEBUG_LOG_POLICY_ID,
  ZED_ROTATED_LOG_POLICY_ID,
} from "../../src/core/provider-file-policy.js";

async function actionFor(
  ownerRoot: string,
  relativePath: string,
  mtime = new Date("2026-06-01T00:00:00.000Z"),
): Promise<Extract<ProviderFileQuarantineAction, { adapter: "claude" }>> {
  const path = join(ownerRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "synthetic provider data\n");
  await utimes(path, mtime, mtime);
  const target = await inspectProviderFile(path, ownerRoot, "claude");
  return {
    actionId: "provider.file-quarantine:policy-test",
    type: "provider.file-quarantine",
    adapter: "claude",
    resourceId: "claude:agent-log-store:policy-test",
    policyId: CLAUDE_DEBUG_LOG_POLICY_ID,
    risk: "recoverable",
    description: "quarantine a synthetic Claude debug log",
    expectedReclaimBytes: 0,
    pendingQuarantineBytes: target.measuredBytes,
    quarantineTtlMinutes: 7 * 24 * 60,
    target,
  };
}

async function cacheActionFor(
  ownerRoot: string,
  relativePath: string,
  mtime = new Date("2026-06-01T00:00:00.000Z"),
): Promise<Extract<ProviderFileQuarantineAction, { adapter: "claude" }>> {
  const action = await actionFor(ownerRoot, relativePath, mtime);
  return {
    ...action,
    resourceId: "claude:agent-cache:policy-test",
    policyId: CLAUDE_CHANGELOG_CACHE_POLICY_ID,
    description: "quarantine a synthetic Claude changelog cache",
  };
}

async function zedActionFor(
  ownerRoot: string,
  relativePath: string,
  mtime = new Date("2026-06-01T00:00:00.000Z"),
): Promise<Extract<ProviderFileQuarantineAction, { adapter: "zed" }>> {
  const path = join(ownerRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "synthetic Zed log\n");
  await utimes(path, mtime, mtime);
  const target = await inspectProviderFile(path, ownerRoot, "zed");
  return {
    actionId: "provider.file-quarantine:zed-policy-test",
    type: "provider.file-quarantine",
    adapter: "zed",
    resourceId: "zed:agent-log-store:policy-test",
    policyId: ZED_ROTATED_LOG_POLICY_ID,
    risk: "recoverable",
    description: "quarantine a synthetic rotated Zed log",
    expectedReclaimBytes: 0,
    pendingQuarantineBytes: target.measuredBytes,
    quarantineTtlMinutes: 7 * 24 * 60,
    target,
  };
}

describe("provider file policy", () => {
  it("authorizes an exact Claude debug text file under CLAUDE_CONFIG_DIR", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const action = await actionFor(ownerRoot, "debug/session.txt");

    await expect(
      authorizeProviderFileAction(
        action,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-25T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["debug/session.jsonl", "debug/nested/session.txt", "projects/session.txt"])(
    "rejects the non-policy path %s",
    async (relativePath) => {
      const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
      const ownerRoot = join(home, "claude-data");
      const action = await actionFor(ownerRoot, relativePath);

      await expect(
        authorizeProviderFileAction(
          action,
          home,
          DEFAULT_CONFIG,
          "darwin",
          {
            CLAUDE_CONFIG_DIR: ownerRoot,
          },
          new Date("2026-07-25T00:00:00.000Z"),
        ),
      ).rejects.toThrow(
        `provider-file target is not approved by policy claude:${CLAUDE_DEBUG_LOG_POLICY_ID}`,
      );
    },
  );

  it.skipIf(sep !== "/")("rejects a root-level debug filename containing a backslash", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const action = await actionFor(ownerRoot, "debug\\session.txt");

    await expect(
      authorizeProviderFileAction(
        action,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-25T00:00:00.000Z"),
      ),
    ).rejects.toThrow(
      `provider-file target is not approved by policy claude:${CLAUDE_DEBUG_LOG_POLICY_ID}`,
    );
  });

  it("rejects recent logs and shortened recovery windows at authorization", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const recent = await actionFor(
      ownerRoot,
      "debug/recent.txt",
      new Date("2026-07-20T00:00:00.000Z"),
    );

    await expect(
      authorizeProviderFileAction(
        recent,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-25T00:00:00.000Z"),
      ),
    ).rejects.toThrow("Claude debug logs must be at least 30 days old");

    const old = await actionFor(ownerRoot, "debug/old.txt");
    old.quarantineTtlMinutes = 60;
    await expect(
      authorizeProviderFileAction(
        old,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-25T00:00:00.000Z"),
      ),
    ).rejects.toThrow("at least seven days");
  });

  it("authorizes only the exact old Claude changelog cache", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const action = await cacheActionFor(ownerRoot, "cache/changelog.md");

    await expect(
      authorizeProviderFileAction(
        action,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-27T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["cache/my-closed-issues.json", "cache/nested/changelog.md", "changelog.md"])(
    "rejects the non-cache-policy path %s",
    async (relativePath) => {
      const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
      const ownerRoot = join(home, "claude-data");
      const action = await cacheActionFor(ownerRoot, relativePath);

      await expect(
        authorizeProviderFileAction(
          action,
          home,
          DEFAULT_CONFIG,
          "darwin",
          {
            CLAUDE_CONFIG_DIR: ownerRoot,
          },
          new Date("2026-07-27T00:00:00.000Z"),
        ),
      ).rejects.toThrow(
        `provider-file target is not approved by policy claude:${CLAUDE_CHANGELOG_CACHE_POLICY_ID}`,
      );
    },
  );

  it.skipIf(sep !== "/")("rejects a root-level cache filename containing a backslash", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const action = await cacheActionFor(ownerRoot, "cache\\changelog.md");

    await expect(
      authorizeProviderFileAction(
        action,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-27T00:00:00.000Z"),
      ),
    ).rejects.toThrow(
      `provider-file target is not approved by policy claude:${CLAUDE_CHANGELOG_CACHE_POLICY_ID}`,
    );
  });

  it("rejects recent changelog caches and shortened recovery windows at authorization", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const recent = await cacheActionFor(
      ownerRoot,
      "cache/changelog.md",
      new Date("2026-07-20T00:00:00.000Z"),
    );

    await expect(
      authorizeProviderFileAction(
        recent,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-27T00:00:00.000Z"),
      ),
    ).rejects.toThrow("Claude changelog caches must be at least 30 days old");

    const old = await cacheActionFor(ownerRoot, "cache/changelog.md");
    old.quarantineTtlMinutes = 60;
    await expect(
      authorizeProviderFileAction(
        old,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {
          CLAUDE_CONFIG_DIR: ownerRoot,
        },
        new Date("2026-07-27T00:00:00.000Z"),
      ),
    ).rejects.toThrow("at least seven days");
  });

  it("authorizes the exact old rotated Zed log under the default macOS log root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "Library", "Logs", "Zed");
    const action = await zedActionFor(ownerRoot, "Zed.log.old");

    await expect(
      authorizeProviderFileAction(
        action,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {},
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  it("authorizes the rotated Zed log under an explicit data root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const dataRoot = join(home, "custom-zed");
    const ownerRoot = join(dataRoot, "logs");
    const action = await zedActionFor(ownerRoot, "Zed.log.old");
    const config = {
      ...DEFAULT_CONFIG,
      adapters: {
        ...DEFAULT_CONFIG.adapters,
        zed: { enabled: true, root: dataRoot },
      },
    };

    await expect(
      authorizeProviderFileAction(
        action,
        home,
        config,
        "darwin",
        {},
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["Zed.log", "Zed.log.old.backup", join("nested", "Zed.log.old")])(
    "rejects the non-Zed-log-policy path %s",
    async (relativePath) => {
      const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
      const ownerRoot = join(home, "Library", "Logs", "Zed");
      const action = await zedActionFor(ownerRoot, relativePath);

      await expect(
        authorizeProviderFileAction(
          action,
          home,
          DEFAULT_CONFIG,
          "darwin",
          {},
          new Date("2026-07-28T00:00:00.000Z"),
        ),
      ).rejects.toThrow(
        `provider-file target is not approved by policy zed:${ZED_ROTATED_LOG_POLICY_ID}`,
      );
    },
  );

  it("rejects recent rotated Zed logs, shortened recovery, and the wrong owner root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "Library", "Logs", "Zed");
    const recent = await zedActionFor(
      ownerRoot,
      "Zed.log.old",
      new Date("2026-07-20T00:00:00.000Z"),
    );

    await expect(
      authorizeProviderFileAction(
        recent,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {},
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).rejects.toThrow("Zed rotated logs must be at least 30 days old");

    const old = await zedActionFor(ownerRoot, "Zed.log.old");
    old.quarantineTtlMinutes = 60;
    await expect(
      authorizeProviderFileAction(
        old,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {},
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).rejects.toThrow("at least seven days");

    const wrongRoot = join(home, "wrong-zed-logs");
    const wrong = await zedActionFor(wrongRoot, "Zed.log.old");
    await expect(
      authorizeProviderFileAction(
        wrong,
        home,
        DEFAULT_CONFIG,
        "darwin",
        {},
        new Date("2026-07-28T00:00:00.000Z"),
      ),
    ).rejects.toThrow("provider-file target is outside the configured zed root");
  });
});
