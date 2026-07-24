import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeAuditCommand } from "../../src/commands/audit.js";
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
    await access(audit.statePath);

    const plan = await executePlanCommand({
      audit: auditOutput,
      stateDir,
    });
    await access(plan.statePath);

    expect(plan.plan.auditId).toBe(audit.report.auditId);
  });
});
