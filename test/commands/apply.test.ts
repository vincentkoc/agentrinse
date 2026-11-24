import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { confirmApply, executeApplyCommand } from "../../src/commands/apply.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import * as processOwnership from "../../src/core/process-ownership.js";
import { sha256Json } from "../../src/core/digest.js";
import { measurePath } from "../../src/core/measure.js";
import { cleanupPlanId } from "../../src/core/plan.js";
import { assertDestructiveFixtureRoot } from "../../src/core/safety.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";

describe("executeApplyCommand", () => {
  it("propagates cancellation into interactive confirmation", async () => {
    const controller = new AbortController();

    await expect(
      confirmApply(1, controller.signal, {
        isInteractive: () => true,
        question: async (_prompt, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(new Error("interrupted by SIGINT"));
          throw Object.assign(new Error("question aborted"), { name: "AbortError" });
        },
      }),
    ).rejects.toMatchObject({ name: "CommandInterruptedError" });
  });

  it("requires --yes before entering JSON mode", async () => {
    await expect(
      executeApplyCommand({
        plan: "unused.json",
        yes: false,
        json: true,
      }),
    ).rejects.toThrow("apply --json requires --yes");
  });

  it.each([true, false])("reports logical bytes for a sparse artifact (json=%s)", async (json) => {
    using _probe = vi
      .spyOn(processOwnership, "findProcessesUsingPath")
      .mockResolvedValue({ status: "idle", matches: [] });
    const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-command-")));
    await assertDestructiveFixtureRoot(home);
    const project = join(home, "project");
    const target = join(project, "node_modules");
    const stateDir = join(home, "state");
    const configPath = join(home, "config.json");
    const planPath = join(home, "plan.json");
    await mkdir(target, { recursive: true });
    await writeFile(join(project, "source.ts"), "keep");
    const logicalBytes = 128 * 1024 * 1024;
    const sparse = await open(join(target, "cache.bin"), "w");
    try {
      await sparse.write(Buffer.from([1]), 0, 1, logicalBytes - 1);
    } finally {
      await sparse.close();
    }
    const stats = await stat(target);
    const measurement = await measurePath(target, { maxEntries: 100 });
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      artifacts: {
        ...structuredClone(DEFAULT_CONFIG.artifacts),
        projects: [{ root: project, names: ["node_modules" as const] }],
        minAgeMinutes: 0,
        minBytes: 0,
      },
    };
    const content: Omit<CleanupPlan, "planId"> = {
      schemaVersion: 1,
      auditId: "audit-1",
      home,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      policyVersion: 1,
      riskCeiling: "safe",
      configDigest: sha256Json(config),
      auditDigest: "audit",
      actions: [
        {
          actionId: "action-1",
          type: "artifacts.remove",
          adapter: "artifacts",
          resourceId: "resource-1",
          risk: "safe",
          description: "remove fixture",
          expectedReclaimBytes: measurement.bytes,
          target: {
            path: target,
            projectRoot: project,
            name: "node_modules",
            device: stats.dev,
            inode: stats.ino,
            mtimeMs: stats.mtimeMs,
            measuredBytes: measurement.bytes,
            newestMtimeMs: measurement.newestMtimeMs,
            fingerprint: measurement.fingerprint,
          },
        },
      ],
      expectedReclaimBytes: measurement.bytes,
    };
    await writeJsonAtomic(configPath, config);
    await writeJsonAtomic(planPath, {
      ...content,
      planId: cleanupPlanId(content),
    });

    const result = await executeApplyCommand({
      plan: planPath,
      config: configPath,
      stateDir,
      yes: true,
      json,
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.actions[0]?.status).toBe("applied");
    expect(result.run.reclaimedBytes).toBe(logicalBytes);
    if (json) expect(JSON.parse(result.output)).toEqual(result.run);
    else expect(result.output).toContain(`reclaimed ${logicalBytes} logical artifact bytes`);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(project, "source.ts"), "utf8")).resolves.toBe("keep");
    await expect(readFile(result.journalPath, "utf8")).resolves.toContain('"status": "completed"');
  });
});
