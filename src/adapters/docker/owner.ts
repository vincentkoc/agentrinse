import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sha256Json } from "../../core/digest.js";

const execFileAsync = promisify(execFile);

export const DOCKER_BUILD_CACHE_MINIMUM_AGE_HOURS = 168;
export const DOCKER_BUILDX_CONTRACT_MIN_VERSION = "0.33.0";
export const DOCKER_BUILDX_CONTRACT_MAX_VERSION = "0.35.99";

const CACHE_ID_PATTERN = /^[a-z0-9]{20,128}$/u;

export type DockerRunner = (args: string[]) => Promise<string>;

export type DockerContextIdentity = {
  name: string;
  endpoint: string;
  daemonId: string;
  serverVersion: string;
  commandPrefix: string[];
};

export type DockerBuilderNodeIdentity = {
  name: string;
  endpoint: string;
  version?: string;
  workerIds: string[];
};

export type DockerBuilderIdentity = {
  name: string;
  driver: string;
  dynamic: boolean;
  nodes: DockerBuilderNodeIdentity[];
  fingerprint: string;
};

export type DockerScopeIdentity = {
  buildxVersion: string;
  context: DockerContextIdentity;
  builder: DockerBuilderIdentity;
};

export type DockerBuildCacheAgeEvidence =
  | {
      kind: "timestamp";
      lastUsedAt: string;
    }
  | {
      kind: "relative";
      observed: string;
      lowerBoundHours: number;
    }
  | {
      kind: "unknown";
    };

export type DockerBuildCacheRecord = {
  id: string;
  createdAt: string;
  mutable: boolean;
  reclaimable: boolean;
  shared: boolean;
  sizeEvidence:
    | {
        kind: "exact";
        bytes: number;
      }
    | {
        kind: "humanized";
        observed: string;
        approximateBytes: number;
      };
  usageCount: number;
  parents: string[];
  recordType?: string;
  ageEvidence: DockerBuildCacheAgeEvidence;
  fingerprint: string;
};

export class DockerOwnerContractError extends Error {
  override readonly name = "DockerOwnerContractError";
}

export async function defaultDockerRunner(args: string[]): Promise<string> {
  return createDockerRunner()(args);
}

export function createDockerRunner(environment: NodeJS.ProcessEnv = process.env): DockerRunner {
  return async (args) => {
    const result = await execFileAsync("docker", args, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    });
    return result.stdout;
  };
}

function parseJsonLines(input: string): Record<string, unknown>[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function requireString(record: Record<string, unknown>, key: string, description = key): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DockerOwnerContractError(`Docker ${description} is missing`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new DockerOwnerContractError(`Docker ${key} is not boolean`);
  }
  return value;
}

function requireNonnegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DockerOwnerContractError(`Docker ${key} is not a nonnegative integer`);
  }
  return value;
}

function parseSemver(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null || match[4] !== undefined) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function supportsDockerBuildxContract(version: string): boolean {
  const parsed = parseSemver(version);
  const minimum = parseSemver(DOCKER_BUILDX_CONTRACT_MIN_VERSION)!;
  const maximum = parseSemver(DOCKER_BUILDX_CONTRACT_MAX_VERSION)!;
  return (
    parsed !== undefined &&
    compareSemver(parsed, minimum) >= 0 &&
    compareSemver(parsed, maximum) <= 0
  );
}

function parseBuildxVersion(output: string): string {
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/u.exec(
    output,
  );
  if (match?.[1] === undefined) {
    throw new DockerOwnerContractError("Docker Buildx version is unrecognized");
  }
  return match[1];
}

function parseDate(value: string, description: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DockerOwnerContractError(`Docker ${description} is not a supported timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function parseSizeEvidence(value: unknown): DockerBuildCacheRecord["sizeEvidence"] {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return { kind: "exact", bytes: value };
  }
  if (typeof value !== "string") {
    throw new DockerOwnerContractError("Docker cache size is not numeric");
  }
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const bytes = Number(trimmed);
    if (Number.isSafeInteger(bytes)) {
      return { kind: "exact", bytes };
    }
  }
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB|EB|ZB|YB)$/iu.exec(trimmed);
  if (match === null) {
    throw new DockerOwnerContractError("Docker cache size is not a supported byte value");
  }
  const exponent = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"].indexOf(
    match[2]!.toUpperCase(),
  );
  const bytes = Math.round(Number(match[1]) * 1000 ** exponent);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new DockerOwnerContractError("Docker cache size exceeds the supported range");
  }
  return {
    kind: "humanized",
    observed: trimmed,
    approximateBytes: bytes,
  };
}

function relativeAgeLowerBoundHours(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "less than a second ago") {
    return 0;
  }
  if (normalized === "about a minute ago") {
    return 1 / 60;
  }
  if (normalized === "about an hour ago") {
    return 1;
  }
  const withoutAgo = normalized.replace(/\s+ago$/u, "");
  const match = /^(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)$/u.exec(
    withoutAgo,
  );
  if (match === null) {
    return undefined;
  }
  const count = Number(match[1]);
  const unit = match[2]!;
  if (unit.startsWith("second")) {
    return count / 3600;
  }
  if (unit.startsWith("minute")) {
    return count / 60;
  }
  if (unit.startsWith("hour")) {
    return Math.max(0, count - 0.5);
  }
  if (unit.startsWith("day")) {
    return Math.max(0, count * 24 - 0.5);
  }
  if (unit.startsWith("week")) {
    return Math.max(0, count * 7 * 24 - 0.5);
  }
  if (unit.startsWith("month")) {
    return Math.max(0, count * 30 * 24 - 0.5);
  }
  return Math.max(0, count * 365 * 24);
}

function parseAgeEvidence(value: unknown): DockerBuildCacheAgeEvidence {
  if (value === undefined || value === null || value === "") {
    return { kind: "unknown" };
  }
  if (typeof value !== "string") {
    throw new DockerOwnerContractError("Docker cache last-used value is unsupported");
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return {
      kind: "timestamp",
      lastUsedAt: new Date(parsed).toISOString(),
    };
  }
  const lowerBoundHours = relativeAgeLowerBoundHours(value);
  return {
    kind: "relative",
    observed: value.trim(),
    lowerBoundHours: lowerBoundHours ?? 0,
  };
}

function parseStringArray(value: unknown, description: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DockerOwnerContractError(`Docker ${description} is not a string array`);
  }
  return [...new Set(value)].sort();
}

function parseBuilderNode(value: unknown): DockerBuilderNodeIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DockerOwnerContractError("Docker Buildx node is malformed");
  }
  const record = value as Record<string, unknown>;
  const error = optionalString(record, "Err");
  const status = optionalString(record, "Status");
  if (error !== undefined || status !== "running") {
    throw new DockerOwnerContractError("Docker Buildx node is not healthy and running");
  }
  const version = optionalString(record, "Version");
  const workerIds = parseStringArray(record["IDs"] ?? [], "Buildx worker IDs");
  if (workerIds.length === 0 || workerIds.some((id) => id.trim() === "")) {
    throw new DockerOwnerContractError("Docker Buildx node has no stable worker IDs");
  }
  return {
    name: requireString(record, "Name", "Buildx node name"),
    endpoint: requireString(record, "Endpoint", "Buildx node endpoint"),
    ...(version === undefined ? {} : { version }),
    workerIds,
  };
}

function parseBuilder(
  records: Record<string, unknown>[],
  builderOverride?: string,
): DockerBuilderIdentity {
  const selected =
    builderOverride === undefined
      ? records.filter((record) => record["Current"] === true)
      : records.filter((record) => record["Name"] === builderOverride);
  if (selected.length !== 1) {
    throw new DockerOwnerContractError("Docker Buildx selected builder is ambiguous");
  }
  const record = selected[0]!;
  const error = optionalString(record, "Err");
  if (error !== undefined) {
    throw new DockerOwnerContractError(`Docker Buildx builder is unavailable: ${error}`);
  }
  const nodesValue = record["Nodes"];
  if (!Array.isArray(nodesValue) || nodesValue.length === 0) {
    throw new DockerOwnerContractError("Docker Buildx builder has no nodes");
  }
  const dynamic = requireBoolean(record, "Dynamic");
  if (dynamic) {
    throw new DockerOwnerContractError(
      "Docker Buildx dynamic builders cannot bind cache records to an inspected worker",
    );
  }
  const identity = {
    name: requireString(record, "Name", "Buildx builder name"),
    driver: requireString(record, "Driver", "Buildx builder driver"),
    dynamic,
    nodes: nodesValue
      .map(parseBuilderNode)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  return {
    ...identity,
    fingerprint: sha256Json(identity),
  };
}

export async function inspectDockerContext(
  runDocker: DockerRunner = defaultDockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DockerContextIdentity> {
  const contextName = (await runDocker(["context", "show"])).trim();
  if (contextName === "") {
    throw new DockerOwnerContractError("Docker context is missing");
  }
  const dockerContext = environment["DOCKER_CONTEXT"]?.trim();
  const dockerHost = environment["DOCKER_HOST"]?.trim();
  const usesEnvironmentHost =
    (dockerContext === undefined || dockerContext === "") &&
    dockerHost !== undefined &&
    dockerHost !== "";
  const commandPrefix = usesEnvironmentHost ? [] : ["--context", contextName];
  let endpoint = dockerHost;
  if (!usesEnvironmentHost) {
    const endpointOutput = await runDocker([
      "context",
      "inspect",
      contextName,
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ]);
    const inspectedEndpoint = JSON.parse(endpointOutput.trim()) as unknown;
    if (typeof inspectedEndpoint !== "string" || inspectedEndpoint.trim() === "") {
      throw new DockerOwnerContractError("Docker context endpoint is missing");
    }
    endpoint = inspectedEndpoint.trim();
  }

  const daemon = JSON.parse(
    await runDocker([...commandPrefix, "info", "--format", "{{json .}}"]),
  ) as Record<string, unknown>;
  return {
    name: contextName,
    endpoint: endpoint!,
    daemonId: requireString(daemon, "ID", "daemon ID"),
    serverVersion: requireString(daemon, "ServerVersion", "server version"),
    commandPrefix,
  };
}

export async function inspectDockerScope(
  runDocker: DockerRunner = defaultDockerRunner,
  builderOverride?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DockerScopeIdentity> {
  const context = await inspectDockerContext(runDocker, environment);
  const selectedBuilder = builderOverride?.trim() || undefined;
  const buildxVersion = parseBuildxVersion(await runDocker(["buildx", "version"]));
  if (!supportsDockerBuildxContract(buildxVersion)) {
    throw new DockerOwnerContractError(
      `Docker Buildx ${buildxVersion} is outside the inspected ${DOCKER_BUILDX_CONTRACT_MIN_VERSION}-${DOCKER_BUILDX_CONTRACT_MAX_VERSION} contract`,
    );
  }
  const builders = parseJsonLines(
    await runDocker([...context.commandPrefix, "buildx", "ls", "--format=json"]),
  );

  return {
    buildxVersion,
    context,
    builder: parseBuilder(builders, selectedBuilder),
  };
}

function parseCacheRecord(value: Record<string, unknown>): DockerBuildCacheRecord {
  const id = requireString(value, "ID", "cache ID");
  if (!CACHE_ID_PATTERN.test(id)) {
    throw new DockerOwnerContractError("Docker build-cache ID is unsupported");
  }
  const recordType = optionalString(value, "Type");
  const stable = {
    id,
    createdAt: parseDate(requireString(value, "CreatedAt"), "cache creation time"),
    mutable: requireBoolean(value, "Mutable"),
    reclaimable: requireBoolean(value, "Reclaimable"),
    shared: requireBoolean(value, "Shared"),
    sizeEvidence: parseSizeEvidence(value["Size"]),
    usageCount: requireNonnegativeInteger(value, "UsageCount"),
    parents: parseStringArray(value["Parents"] ?? [], "cache parents"),
    ...(recordType === undefined ? {} : { recordType }),
  };
  const ageEvidence = parseAgeEvidence(value["LastUsedAt"]);
  const fingerprintFacts = {
    ...stable,
    ...(ageEvidence.kind === "timestamp" ? { lastUsedAt: ageEvidence.lastUsedAt } : {}),
  };
  return {
    ...stable,
    ageEvidence,
    fingerprint: sha256Json(fingerprintFacts),
  };
}

export async function inspectDockerBuildCache(
  scope: DockerScopeIdentity,
  runDocker: DockerRunner = defaultDockerRunner,
  onUnsupportedRecord?: (index: number, error: DockerOwnerContractError) => void,
): Promise<DockerBuildCacheRecord[]> {
  const output = await runDocker([
    ...scope.context.commandPrefix,
    "buildx",
    "du",
    "--builder",
    scope.builder.name,
    "--format=json",
  ]);
  const records: DockerBuildCacheRecord[] = [];
  for (const [index, line] of output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .entries()) {
    try {
      records.push(parseCacheRecord(JSON.parse(line) as Record<string, unknown>));
    } catch (error) {
      const ownerError =
        error instanceof DockerOwnerContractError
          ? error
          : new DockerOwnerContractError(
              `Docker build-cache record is malformed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
      onUnsupportedRecord?.(index, ownerError);
    }
  }
  return records;
}

export function dockerBuildCacheIsOldEnough(
  record: DockerBuildCacheRecord,
  now: Date,
  minimumAgeHours = DOCKER_BUILD_CACHE_MINIMUM_AGE_HOURS,
): boolean {
  if (record.ageEvidence.kind === "relative") {
    return record.ageEvidence.lowerBoundHours >= minimumAgeHours;
  }
  if (record.ageEvidence.kind === "unknown") {
    return false;
  }
  const relevantTimestamp = Date.parse(record.ageEvidence.lastUsedAt);
  return now.getTime() - relevantTimestamp >= minimumAgeHours * 60 * 60 * 1000;
}
