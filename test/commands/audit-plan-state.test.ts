import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeAuditCommand } from "../../src/commands/audit.js";
import { executeApplyCommand } from "../../src/commands/apply.js";
import { executePlanCommand } from "../../src/commands/plan.js";

describe("audit and plan state persistence", () => {
  it("stores validated audit and plan records under the selected state root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-audit-state-home-"));
    const stateDir = await mkdtemp(join(tmpdir(), "agentrinse-audit-state-"));
    const auditOutput = join(stateDir, "audit-output.json");

    const audit = await executeAuditCommand({
      home,
      json: true,
      output: auditOutput,
      stateDir,
    });
    expect(audit.statePath).toBeTypeOf("string");
    await access(audit.statePath!);

    const plan = await executePlanCommand({
      audit: auditOutput,
      stateDir,
    });
    await access(plan.statePath);

    expect(plan.plan.auditId).toBe(audit.report.auditId);
  });

  it("uses the same explicit risk ceiling for plan creation and apply verification", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-risk-home-"));
    const stateDir = await mkdtemp(join(tmpdir(), "agentrinse-risk-state-"));
    const auditOutput = join(stateDir, "audit.json");
    const planOutput = join(stateDir, "plan.json");

    await executeAuditCommand({
      home,
      json: true,
      output: auditOutput,
      stateDir,
    });
    const planned = await executePlanCommand({
      audit: auditOutput,
      maxRisk: "experimental",
      output: planOutput,
      stateDir,
    });
    expect(planned.plan.riskCeiling).toBe("experimental");

    await expect(
      executeApplyCommand({
        plan: planOutput,
        stateDir,
        yes: true,
        json: true,
      }),
    ).rejects.toThrow("configuration changed after this cleanup plan was created");

    const applied = await executeApplyCommand({
      plan: planOutput,
      stateDir,
      yes: true,
      json: true,
      maxRisk: "experimental",
    });
    expect(applied.run.status).toBe("completed");
  });
});
