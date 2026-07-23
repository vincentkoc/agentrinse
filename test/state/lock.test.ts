import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LockHeldError, acquireApplyLock } from "../../src/state/lock.js";

describe("apply state lock", () => {
  it("allows one owner and refuses a concurrent owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const first = await acquireApplyLock(root, "plan-1");

    await expect(acquireApplyLock(root, "plan-2")).rejects.toBeInstanceOf(LockHeldError);

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

  it("fails closed when a stale-looking lock exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const path = join(root, "apply.lock");
    await writeFile(
      path,
      JSON.stringify({
        token: "stale",
        pid: 2_147_483_647,
        hostname: hostname(),
        planId: "old-plan",
        createdAt: "2026-07-23T00:00:00.000Z",
      }),
    );

    await expect(acquireApplyLock(root, "new-plan")).rejects.toThrow(
      "verify its recorded process before removing a stale lock",
    );
    expect(JSON.parse(await readFile(path, "utf8")).planId).toBe("old-plan");
  });

  it("does not remove a replacement lock during release", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const lock = await acquireApplyLock(root, "plan-1");
    await writeFile(
      lock.path,
      JSON.stringify({
        token: "replacement",
        pid: process.pid,
        hostname: hostname(),
        planId: "plan-2",
        createdAt: "2026-07-23T00:00:00.000Z",
      }),
    );

    await lock.release();
    expect(JSON.parse(await readFile(lock.path, "utf8")).planId).toBe("plan-2");
  });
});
