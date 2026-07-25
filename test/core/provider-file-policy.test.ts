import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
): Promise<Extract<ProviderFileQuarantineAction, { adapter: "claude" }>> {
  const path = join(ownerRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "synthetic provider data\n");
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
    quarantineTtlMinutes: 60,
    target,
  };
}

describe("provider file policy", () => {
  it("authorizes an exact Claude debug text file under CLAUDE_CONFIG_DIR", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
    const ownerRoot = join(home, "claude-data");
    const action = await actionFor(ownerRoot, "debug/session.txt");

    await expect(
      authorizeProviderFileAction(action, home, DEFAULT_CONFIG, "darwin", {
        CLAUDE_CONFIG_DIR: ownerRoot,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["debug/session.jsonl", "debug/nested/session.txt", "projects/session.txt"])(
    "rejects the non-policy path %s",
    async (relativePath) => {
      const home = await mkdtemp(join(tmpdir(), "agentrinse-policy-home-"));
      const ownerRoot = join(home, "claude-data");
      const action = await actionFor(ownerRoot, relativePath);

      await expect(
        authorizeProviderFileAction(action, home, DEFAULT_CONFIG, "darwin", {
          CLAUDE_CONFIG_DIR: ownerRoot,
        }),
      ).rejects.toThrow(
        `provider-file target is not approved by policy claude:${CLAUDE_DEBUG_LOG_POLICY_ID}`,
      );
    },
  );
});
