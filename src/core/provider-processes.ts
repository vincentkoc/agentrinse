import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

import type { ProviderMutationId } from "../contracts/action.js";

const execFileAsync = promisify(execFile);

export type ProviderProcessResult =
  | { status: "idle"; pids: [] }
  | { status: "busy"; pids: number[] }
  | { status: "unknown"; pids: []; reason: string };

const PROCESS_NAMES: Record<ProviderMutationId, string[]> = {
  claude: ["claude"],
  cursor: ["cursor", "cursor helper"],
  copilot: ["copilot"],
  zed: ["zed", "zed-editor"],
  opencode: ["opencode"],
  grok: ["grok"],
};

function normalizeCommand(command: string): string {
  return basename(command).replace(/\.exe$/iu, "").toLowerCase();
}

function commandMatches(provider: ProviderMutationId, command: string): boolean {
  const normalized = normalizeCommand(command);
  return PROCESS_NAMES[provider]!.some(
    (name) => normalized === name || normalized.startsWith(`${name} `),
  );
}

export async function inspectProviderProcesses(
  provider: ProviderMutationId,
): Promise<ProviderProcessResult> {
  try {
    const result = await execFileAsync("ps", ["-axo", "pid=,comm="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    const pids = result.stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(.+?)\s*$/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter((match) => commandMatches(provider, match[2]!))
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((pid) => pid !== process.pid);
    return pids.length === 0 ? { status: "idle", pids: [] } : { status: "busy", pids };
  } catch (error) {
    return {
      status: "unknown",
      pids: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
