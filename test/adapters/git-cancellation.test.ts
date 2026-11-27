import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { expect, it, vi } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import type { AuditContext } from "../../src/contracts/adapter.js";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";

function context(home: string, signal: AbortSignal): AuditContext {
  return { home, now: new Date(), auditId: "cancelled-git-audit", signal };
}

it("preserves completed records and starts no more Git work after cancellation", async () => {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-git-cancel-")));
  const missing = join(home, "missing");
  const controller = new AbortController();
  const reason = new Error("Git collection deadline");
  let notifyEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    notifyEntered = resolve;
  });
  let releaseStatus!: (output: string) => void;
  const finishStatus = new Promise<string>((resolve) => {
    releaseStatus = resolve;
  });
  const runGit = vi.fn(async () => {
    notifyEntered();
    return finishStatus;
  });
  const records = [missing, home, join(home, "later")].map((path) => ({
    path,
    bare: false,
    detached: false,
  }));
  const adapter = new GitWorktreeAuditAdapter(
    home,
    runGit,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      discovery: { records },
    },
  );
  const audit = context(home, controller.signal);
  const reported: (string | undefined)[] = [];
  const pending = adapter.collect(audit, await adapter.probe(audit), {
    reportResource: (resource) => reported.push(resource.resource.path),
    reportDiagnostic: () => {},
  });
  await entered;
  controller.abort(reason);
  releaseStatus("");
  await expect(pending).rejects.toBe(reason);
  expect(runGit).toHaveBeenCalledTimes(1);
  expect(reported).toEqual([missing]);
});

it.skipIf(process.platform === "win32")("stops the running native Git child on abort", async () => {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-git-child-")));
  const ready = join(home, "ready");
  const stopped = join(home, "stopped");
  await writeFile(
    join(home, "git"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const { join } = require('node:path');",
      "const timeout = setTimeout(() => process.exit(1), 10000);",
      "process.once('SIGTERM', () => { fs.writeFileSync(join(__dirname, 'stopped'), 'yes'); clearTimeout(timeout); });",
      "fs.writeFileSync(join(__dirname, 'ready'), 'yes');",
    ].join("\n"),
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${home}${delimiter}${process.env.PATH}`);
  const controller = new AbortController();
  const reason = new Error("cancel native Git");
  const pending = new GitWorktreeAuditAdapter(home).probe(context(home, controller.signal));
  try {
    await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("yes"), {
      timeout: 3000,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await vi.waitFor(async () => expect(await readFile(stopped, "utf8")).toBe("yes"));
  } finally {
    controller.abort(reason);
    await pending.catch(() => {});
    vi.unstubAllEnvs();
  }
});
