import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProviderMutationId } from "../contracts/action.js";

const execFileAsync = promisify(execFile);

export type ProviderProcessResult =
  | { status: "idle"; pids: [] }
  | { status: "busy"; pids: number[] }
  | { status: "unknown"; pids: []; reason: string };

export type ProviderProcessOptions = {
  runPs?: () => Promise<string>;
};

const COMMAND_PATTERNS: Record<ProviderMutationId, RegExp[]> = {
  claude: [
    /(?:^|\s)(?:\S*[/\\])?claude(?:\.exe)?(?:\s|$)/iu,
    /(?:^|\s)(?:\S*[/\\])?claude-code(?:\.exe)?(?:\s|$)/iu,
    /@anthropic-ai[/\\]claude-code/iu,
    /Claude\.app[/\\]Contents[/\\]MacOS[/\\]Claude/iu,
  ],
  cursor: [
    /(?:^|\s)(?:\S*[/\\])?cursor(?:\.exe)?(?:\s|$)/iu,
    /cursor-agent/iu,
    /Cursor\.app[/\\]Contents[/\\]MacOS[/\\]Cursor/iu,
    /Cursor Helper/iu,
  ],
  copilot: [
    /(?:^|\s)(?:\S*[/\\])?copilot(?:\.exe)?(?:\s|$)/iu,
    /@github[/\\]copilot/iu,
    /github-copilot/iu,
  ],
  zed: [
    /(?:^|\s)(?:\S*[/\\])?zed(?:\.exe)?(?:\s|$)/iu,
    /zed-editor/iu,
    /Zed\.app[/\\]Contents[/\\]MacOS[/\\]zed/iu,
  ],
  opencode: [/(?:^|\s)(?:\S*[/\\])?opencode(?:\.exe)?(?:\s|$)/iu],
  grok: [/(?:^|\s)(?:\S*[/\\])?grok(?:\.exe)?(?:\s|$)/iu, /grok-build/iu],
};

function commandMatches(provider: ProviderMutationId, commandLine: string): boolean {
  return COMMAND_PATTERNS[provider].some((pattern) => pattern.test(commandLine));
}

async function defaultPs(): Promise<string> {
  const result = await execFileAsync("ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  if (result.stderr !== "") {
    throw new Error(`ps reported incomplete process data: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function inspectProviderProcesses(
  provider: ProviderMutationId,
  options: ProviderProcessOptions = {},
): Promise<ProviderProcessResult> {
  try {
    const output = await (options.runPs ?? defaultPs)();
    const pids: number[] = [];
    let observed = 0;
    let incomplete = false;
    for (const line of output.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
      if (match === null) {
        incomplete = true;
        continue;
      }
      observed += 1;
      const pid = Number.parseInt(match[1]!, 10);
      if (pid !== process.pid && commandMatches(provider, match[2]!)) {
        pids.push(pid);
      }
    }
    if (pids.length > 0) {
      return { status: "busy", pids };
    }
    if (observed === 0 || incomplete) {
      return {
        status: "unknown",
        pids: [],
        reason:
          observed === 0
            ? "ps returned no process records"
            : "ps returned an unparseable process record",
      };
    }
    return { status: "idle", pids: [] };
  } catch (error) {
    return {
      status: "unknown",
      pids: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
