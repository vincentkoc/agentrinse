import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);

export const GROK_SOURCE_CONTRACT = {
  repository: "https://github.com/xai-org/grok-build",
  commit: "5da6962e4adb9c857f3def762542b52b4ec3e522",
  sourceRevision: "2a818575225183d8ca915f5632a09b8067b5156a",
  version: "0.2.112",
  inspectedAt: "2026-07-29",
} as const;

export type GrokVersionRunner = () => Promise<string>;

export const grokOwnerContractFactsSchema = z.object({
  provider: z.literal("grok"),
  kind: z.literal("owner-contract"),
  sourceRepository: z.literal(GROK_SOURCE_CONTRACT.repository),
  sourceCommit: z.literal(GROK_SOURCE_CONTRACT.commit),
  sourceRevision: z.literal(GROK_SOURCE_CONTRACT.sourceRevision),
  sourceVersion: z.literal(GROK_SOURCE_CONTRACT.version),
  sourceInspectedAt: z.literal(GROK_SOURCE_CONTRACT.inspectedAt),
  sourceReleaseTagged: z.literal(false),
  installedVersionStatus: z.enum(["exact", "different", "unavailable", "unparseable"]),
  installedVersion: z.string().min(1).optional(),
  inventoryScope: z.enum(["confirmed-subpaths", "owner-root"]),
  nativeMemoryGc: z.object({
    trigger: z.literal("session-init"),
    configurablePath: z.literal("memory.gc.max_age_days"),
    defaultOrphanAgeDays: z.literal(30),
    temporaryNonEmptyAgeDays: z.literal(7),
    preservesNonEmptyWorkspaceMemory: z.literal(true),
  }),
  mutationAvailable: z.literal(false),
  refusalCode: z.literal("grok-cleanup-owner-contract-unavailable"),
});

export type GrokOwnerContractFacts = z.infer<typeof grokOwnerContractFactsSchema>;

async function defaultRunGrokVersion(environment: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("grok", ["--version"], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 256 * 1024,
    timeout: 5_000,
  });
  return result.stdout.trim() === "" ? result.stderr : result.stdout;
}

export function parseGrokVersion(output: string): string | undefined {
  const firstLine = output.split(/\r?\n/u)[0]?.trim();
  return firstLine?.match(/^grok\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u)?.[1];
}

export async function inspectGrokOwnerContract(
  environment: NodeJS.ProcessEnv,
  runVersion?: GrokVersionRunner,
): Promise<GrokOwnerContractFacts> {
  let installedVersion: string | undefined;
  let installedVersionStatus: GrokOwnerContractFacts["installedVersionStatus"];
  try {
    installedVersion = parseGrokVersion(
      await (runVersion ?? (() => defaultRunGrokVersion(environment)))(),
    );
    installedVersionStatus =
      installedVersion === undefined
        ? "unparseable"
        : installedVersion === GROK_SOURCE_CONTRACT.version
          ? "exact"
          : "different";
  } catch {
    installedVersionStatus = "unavailable";
  }

  return grokOwnerContractFactsSchema.parse({
    provider: "grok",
    kind: "owner-contract",
    sourceRepository: GROK_SOURCE_CONTRACT.repository,
    sourceCommit: GROK_SOURCE_CONTRACT.commit,
    sourceRevision: GROK_SOURCE_CONTRACT.sourceRevision,
    sourceVersion: GROK_SOURCE_CONTRACT.version,
    sourceInspectedAt: GROK_SOURCE_CONTRACT.inspectedAt,
    sourceReleaseTagged: false,
    installedVersionStatus,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    inventoryScope: installedVersionStatus === "exact" ? "confirmed-subpaths" : "owner-root",
    nativeMemoryGc: {
      trigger: "session-init",
      configurablePath: "memory.gc.max_age_days",
      defaultOrphanAgeDays: 30,
      temporaryNonEmptyAgeDays: 7,
      preservesNonEmptyWorkspaceMemory: true,
    },
    mutationAvailable: false,
    refusalCode: "grok-cleanup-owner-contract-unavailable",
  });
}
