import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { BoundedCommandError, runBoundedCommand } from "../../src/core/bounded-command.js";

function controlledChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill,
    unref,
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, kill, stderr, stdout, unref };
}

describe("runBoundedCommand", () => {
  it("settles at the deadline even when the exact child never exits after SIGKILL", async () => {
    const fixture = controlledChild();
    const startedAt = Date.now();

    await expect(
      runBoundedCommand("fixture", [], {
        timeoutMs: 10,
        maxOutputBytes: 1024,
        spawnCommand: () => fixture.child,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      stdout: "",
      stderr: "",
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fixture.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(fixture.unref).toHaveBeenCalledOnce();
    expect(fixture.stdout.destroyed).toBe(true);
    expect(fixture.stderr.destroyed).toBe(true);
  });

  it("kills the exact child and fails when combined output reaches the cap", async () => {
    const fixture = controlledChild();
    const result = runBoundedCommand("fixture", [], {
      timeoutMs: 1_000,
      maxOutputBytes: 4,
      spawnCommand: () => fixture.child,
    });
    fixture.stdout.write("abc");
    fixture.stderr.write("de");

    await expect(result).rejects.toMatchObject({
      code: "ENOBUFS",
      stdout: "abc",
      stderr: "d",
    });
    expect(fixture.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("waits for child close before returning complete output", async () => {
    const fixture = controlledChild();
    const result = runBoundedCommand("fixture", [], {
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
      spawnCommand: () => fixture.child,
    });
    fixture.stdout.write("complete stdout");
    fixture.stderr.write("complete stderr");
    fixture.child.emit("exit", 0, null);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    fixture.stdout.end();
    fixture.stderr.end();
    fixture.child.emit("close", 0, null);
    await expect(result).resolves.toEqual({
      stdout: "complete stdout",
      stderr: "complete stderr",
    });
  });

  it.runIf(process.platform === "darwin")(
    "returns promptly after a native macOS deadline without scanning live files",
    async () => {
      const startedAt = Date.now();
      await expect(
        runBoundedCommand(
          process.execPath,
          ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          {
            timeoutMs: 25,
            maxOutputBytes: 1024,
          },
        ),
      ).rejects.toBeInstanceOf(BoundedCommandError);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
  );
});
