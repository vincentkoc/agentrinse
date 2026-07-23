import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  auditReportSchema,
  cleanupPlanSchema,
  cleanupRunSchema,
} from "../dist/index.js";

const outputDirectory = join(process.cwd(), "schemas");
const check = process.argv.includes("--check");
const schemas = [
  ["audit.schema.json", "audit", auditReportSchema],
  ["plan.schema.json", "plan", cleanupPlanSchema],
  ["run.schema.json", "run", cleanupRunSchema],
];

await mkdir(outputDirectory, { recursive: true });

for (const [filename, name, schema] of schemas) {
  const value = {
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $id: `https://agentrinse.com/schemas/${name}.schema.json`,
    title: `AgentRinse ${name} schema`,
  };
  const output = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(outputDirectory, filename);

  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== output) {
      throw new Error(
        `${filename} is stale; run pnpm schemas:generate`,
      );
    }
  } else {
    await writeFile(path, output, "utf8");
  }
}

process.stdout.write(
  `${check ? "verified" : "generated"} ${schemas.length} JSON schemas\n`,
);
