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
  installedVersionStatus: z.enum([
    "exact",
    "version-mismatch",
    "revision-mismatch",
    "unavailable",
    "unparseable",
  ]),
  installedVersion: z.string().min(1).optional(),
  installedRevision: z.string().min(7).optional(),
  installedChannel: z.enum(["alpha", "stable"]).optional(),
  inventoryScope: z.enum(["confirmed-subpaths", "owner-root"]),
  nativeMemoryGc: z.object({
    trigger: z.literal("session-init"),
    configurablePath: z.literal("memory.gc.max_age_days"),
    defaultOrphanAgeDays: z.literal(30),
    temporaryEmptyRemoval: z.literal("immediate"),
    temporaryNonEmptyAgeDays: z.literal(7),
    preservesNonTemporaryWorkspaceMemory: z.literal(true),
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

export type ParsedGrokVersion = {
  version: string;
  revision: string;
  channel?: "alpha" | "stable";
};

export function parseGrokVersion(output: string): ParsedGrokVersion | undefined {
  const firstLine = output.split(/\r?\n/u)[0]?.trim();
  const match = firstLine?.match(
    /^grok\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\(([0-9a-f]{7,40})\)(?:\s+\[(alpha|stable)\])?$/u,
  );
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return {
    version: match[1],
    revision: match[2],
    ...(match[3] === undefined ? {} : { channel: match[3] as "alpha" | "stable" }),
  };
}

function matchesSourceRevision(revision: string): boolean {
  return [GROK_SOURCE_CONTRACT.commit, GROK_SOURCE_CONTRACT.sourceRevision].some((candidate) =>
    candidate.startsWith(revision),
  );
}

export async function inspectGrokOwnerContract(
  environment: NodeJS.ProcessEnv,
  runVersion?: GrokVersionRunner,
): Promise<GrokOwnerContractFacts> {
  let parsedVersion: ParsedGrokVersion | undefined;
  let installedVersionStatus: GrokOwnerContractFacts["installedVersionStatus"];
  try {
    parsedVersion = parseGrokVersion(
      await (runVersion ?? (() => defaultRunGrokVersion(environment)))(),
    );
    installedVersionStatus =
      parsedVersion === undefined
        ? "unparseable"
        : parsedVersion.version !== GROK_SOURCE_CONTRACT.version
          ? "version-mismatch"
          : matchesSourceRevision(parsedVersion.revision)
            ? "exact"
            : "revision-mismatch";
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
    ...(parsedVersion === undefined
      ? {}
      : {
          installedVersion: parsedVersion.version,
          installedRevision: parsedVersion.revision,
          ...(parsedVersion.channel === undefined
            ? {}
            : { installedChannel: parsedVersion.channel }),
        }),
    inventoryScope: installedVersionStatus === "exact" ? "confirmed-subpaths" : "owner-root",
    nativeMemoryGc: {
      trigger: "session-init",
      configurablePath: "memory.gc.max_age_days",
      defaultOrphanAgeDays: 30,
      temporaryEmptyRemoval: "immediate",
      temporaryNonEmptyAgeDays: 7,
      preservesNonTemporaryWorkspaceMemory: true,
    },
    mutationAvailable: false,
    refusalCode: "grok-cleanup-owner-contract-unavailable",
  });
}
