import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { ProviderFileQuarantineAction } from "../../src/contracts/action.js";
import { inspectProviderFile } from "../../src/core/provider-file-identity.js";
import {
  authorizeProviderFileAction,
  CLAUDE_DEBUG_LOG_POLICY_ID,
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
});
