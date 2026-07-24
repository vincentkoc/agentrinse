import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeApplyCommand } from "../../src/commands/apply.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { CleanupPlan } from "../../src/contracts/plan.js";
import { sha256Json } from "../../src/core/digest.js";
import { measurePath } from "../../src/core/measure.js";
import { cleanupPlanId } from "../../src/core/plan.js";
import { assertDestructiveFixtureRoot } from "../../src/core/safety.js";
import { writeJsonAtomic } from "../../src/state/json-file.js";

describe("executeApplyCommand", () => {
  it("requires --yes before entering JSON mode", async () => {
    await expect(
      executeApplyCommand({
        plan: "unused.json",
        yes: false,
        json: true,
      }),
    ).rejects.toThrow("apply --json requires --yes");
  });

  it("refuses mutation in the reservation release", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-command-")));
    await assertDestructiveFixtureRoot(home);
    const project = join(home, "project");
    const target = join(project, "node_modules");
    const stateDir = join(home, "state");
    const configPath = join(home, "config.json");
    const planPath = join(home, "plan.json");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "cache.bin"), "remove");
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

    await expect(
      executeApplyCommand({
        plan: planPath,
        config: configPath,
        stateDir,
        yes: true,
        json: true,
      }),
    ).rejects.toThrow("apply is unavailable in the unsupported 0.0.0 reservation release");

    await expect(stat(target)).resolves.toBeDefined();
  });
});
