import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LockHeldError,
  LockRecoveryError,
  acquireApplyLock,
  inspectApplyLock,
  recoverStaleApplyLock,
  type ApplyLockOwner,
} from "../../src/state/lock.js";

function request(planId = "plan-1", runId = "run-1") {
  return { planId, runId, command: "agentrinse apply" };
}

function owner(overrides: Partial<ApplyLockOwner> = {}): ApplyLockOwner {
  return {
    token: "lock-token",
    pid: 42,
    processStartIdentity: "fixture-start",
    hostname: hostname(),
    command: "agentrinse apply",
    planId: "plan-1",
    runId: "run-1",
    createdAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

async function writeOwner(root: string, value: ApplyLockOwner): Promise<string> {
  const path = join(root, "apply.lock");
  await writeFile(path, `${JSON.stringify(value)}\n`);
  return path;
}

describe("apply state lock", () => {
  it("allows one owner and refuses a concurrent owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const first = await acquireApplyLock(root, request());

    await expect(acquireApplyLock(root, request("plan-2", "run-2"))).rejects.toBeInstanceOf(
      LockHeldError,
    );

    await first.release();
    const second = await acquireApplyLock(root, request("plan-2", "run-2"));
    await second.release();
  });

  it("records the plan, run, command, and process identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const lock = await acquireApplyLock(root, request());
    const stored = JSON.parse(await readFile(lock.path, "utf8")) as ApplyLockOwner;

    expect(stored).toMatchObject({
      pid: process.pid,
      hostname: hostname(),
      command: "agentrinse apply",
      planId: "plan-1",
      runId: "run-1",
    });
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(stored.processStartIdentity).toBeTypeOf("string");
    }
    await lock.release();
  });

  it("makes release idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const lock = await acquireApplyLock(root, request());

    await lock.release();
    await lock.release();
  });

  it("reports an absent lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await expect(inspectApplyLock(root)).resolves.toMatchObject({ status: "absent" });
  });

  it("reports an active owner when PID and process start identity match", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeOwner(root, owner({ createdAt: "2000-01-01T00:00:00.000Z" }));

    await expect(
      inspectApplyLock(root, {
        inspectProcess: async () => ({ status: "alive", identity: "fixture-start" }),
      }),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("does not treat age as proof that a lock is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeOwner(root, owner({ createdAt: "2000-01-01T00:00:00.000Z" }));

    await expect(
      recoverStaleApplyLock(root, {
        inspectProcess: async () => ({ status: "alive", identity: "fixture-start" }),
      }),
    ).rejects.toThrow("apply lock is active");
  });

  it("reports and recovers a lock whose recorded process is dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const path = await writeOwner(root, owner());
    const dependencies = {
      inspectProcess: async () => ({ status: "dead" as const }),
    };

    await expect(inspectApplyLock(root, dependencies)).resolves.toMatchObject({
      status: "stale",
      reason: "recorded process 42 no longer exists",
    });
    await expect(recoverStaleApplyLock(root, dependencies)).resolves.toMatchObject({
      runId: "run-1",
    });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports PID reuse as stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeOwner(root, owner());

    await expect(
      inspectApplyLock(root, {
        inspectProcess: async () => ({ status: "alive", identity: "different-start" }),
      }),
    ).resolves.toMatchObject({
      status: "stale",
      reason: "PID 42 was reused by a different process",
    });
  });

  it("refuses recovery when a live PID has no recorded start identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const value = owner();
    delete value.processStartIdentity;
    await writeOwner(root, value);

    await expect(
      inspectApplyLock(root, {
        inspectProcess: async () => ({ status: "alive", identity: "fixture-start" }),
      }),
    ).resolves.toMatchObject({ status: "unknown" });
    await expect(
      recoverStaleApplyLock(root, {
        inspectProcess: async () => ({ status: "alive", identity: "fixture-start" }),
      }),
    ).rejects.toBeInstanceOf(LockRecoveryError);
  });

  it("refuses recovery for a lock recorded on another host", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeOwner(root, owner({ hostname: "another-host" }));

    await expect(inspectApplyLock(root)).resolves.toMatchObject({ status: "remote" });
    await expect(recoverStaleApplyLock(root)).rejects.toThrow("apply lock is remote");
  });

  it("refuses recovery for malformed lock records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeFile(join(root, "apply.lock"), '{"pid":42}\n');

    await expect(inspectApplyLock(root)).resolves.toMatchObject({ status: "malformed" });
    await expect(recoverStaleApplyLock(root)).rejects.toThrow("apply lock is malformed");
  });

  it("does not remove a replacement lock during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const path = await writeOwner(root, owner());
    const replacement = owner({
      token: "replacement",
      pid: process.pid,
      processStartIdentity: "replacement-start",
      planId: "plan-2",
      runId: "run-2",
    });

    await expect(
      recoverStaleApplyLock(root, {
        inspectProcess: async () => ({ status: "dead" }),
        beforeRecoveryRemove: async () => {
          await rm(path);
          await writeFile(path, `${JSON.stringify(replacement)}\n`);
        },
      }),
    ).rejects.toThrow("apply lock changed before recovery");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ token: "replacement" });
  });

  it("serializes stale recovery before inspecting the apply lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeOwner(root, owner());
    let continueFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const continueFirstPromise = new Promise<void>((resolve) => {
      continueFirst = resolve;
    });
    const dependencies = {
      inspectProcess: async () => ({ status: "dead" as const }),
    };

    const firstRecovery = recoverStaleApplyLock(root, {
      ...dependencies,
      beforeRecoveryRemove: async () => {
        firstEntered();
        await continueFirstPromise;
      },
    });
    await firstEnteredPromise;

    await expect(recoverStaleApplyLock(root, dependencies)).rejects.toThrow(
      "apply lock recovery is already in progress",
    );
    continueFirst();
    await expect(firstRecovery).resolves.toMatchObject({ token: "lock-token" });

    const replacement = await acquireApplyLock(root, request("plan-2", "run-2"));
    await expect(readFile(replacement.path, "utf8")).resolves.toContain('"planId":"plan-2"');
    await replacement.release();
  });

  it("ignores an orphaned recovery marker when no process holds its kernel lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    await writeOwner(root, owner());
    await writeFile(join(root, "apply.recovery.lock"), "orphaned marker\n");

    await expect(
      recoverStaleApplyLock(root, {
        inspectProcess: async () => ({ status: "dead" }),
      }),
    ).resolves.toMatchObject({ token: "lock-token" });
  });

  it("does not remove a replacement lock during release", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-lock-"));
    const lock = await acquireApplyLock(root, request());
    await writeFile(
      lock.path,
      JSON.stringify(
        owner({
          token: "replacement",
          pid: process.pid,
          planId: "plan-2",
          runId: "run-2",
        }),
      ),
    );

    await lock.release();
    expect(JSON.parse(await readFile(lock.path, "utf8")).planId).toBe("plan-2");
  });
});
