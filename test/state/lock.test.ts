import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LockHeldError,
  acquireApplyLock,
} from "../../src/state/lock.js";

describe("apply state lock", () => {
  it("allows one owner and refuses a concurrent owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const first = await acquireApplyLock(root, "plan-1");

    await expect(acquireApplyLock(root, "plan-2")).rejects.toBeInstanceOf(
      LockHeldError,
    );

    await first.release();
    const second = await acquireApplyLock(root, "plan-2");
    await second.release();
  });

  it("makes release idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const lock = await acquireApplyLock(root, "plan-1");

    await lock.release();
    await lock.release();
  });
});
