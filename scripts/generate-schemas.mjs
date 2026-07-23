import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { auditReportSchema, cleanupPlanSchema, cleanupRunSchema } from "../dist/index.js";

const outputDirectory = join(process.cwd(), "schemas");
const check = process.argv.includes("--check");
const schemas = [
  ["audit.schema.json", "audit", auditReportSchema],
  ["plan.schema.json", "plan", cleanupPlanSchema],
  ["run.schema.json", "run", cleanupRunSchema],
];

async function formatJson(input, path) {
  const formatter = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
  );
  const child = spawn(formatter, [`--stdin-filepath=${path}`], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`oxfmt failed for ${path} with exit code ${code}`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

await mkdir(outputDirectory, { recursive: true });

for (const [filename, name, schema] of schemas) {
  const value = {
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $id: `https://agentrinse.com/schemas/${name}.schema.json`,
    title: `AgentRinse ${name} schema`,
  };
  const path = join(outputDirectory, filename);
  const output = await formatJson(`${JSON.stringify(value, null, 2)}\n`, path);

  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== output) {
      throw new Error(`${filename} is stale; run pnpm schemas:generate`);
    }
  } else {
    await writeFile(path, output, "utf8");
  }
}

process.stdout.write(`${check ? "verified" : "generated"} ${schemas.length} JSON schemas\n`);
