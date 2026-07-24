import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { AuditAdapter, AuditContext, CollectionResult } from "../../contracts/adapter.js";
import type { Diagnostic } from "../../contracts/diagnostic.js";
import type { Finding } from "../../contracts/finding.js";
import type { AdapterProbe } from "../../contracts/report.js";
import type { ResourceSnapshot } from "../../contracts/resource.js";
import { sha256 } from "../../core/digest.js";

const execFileAsync = promisify(execFile);
const RUNTIMES = [
  { tool: "codex", command: "codex", displayName: "Codex CLI" },
  { tool: "claude", command: "claude", displayName: "Claude Code" },
  { tool: "cursor", command: "cursor-agent", displayName: "Cursor Agent" },
  { tool: "copilot", command: "copilot", displayName: "GitHub Copilot CLI" },
  { tool: "opencode", command: "opencode", displayName: "OpenCode" },
  { tool: "grok", command: "grok", displayName: "Grok Build" },
] as const;

export type RuntimeVersionRunner = (executable: string) => Promise<string>;

export type RuntimeAdapterOptions = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runVersion?: RuntimeVersionRunner;
};

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isUnavailableExecutable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["EACCES", "ENOENT", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

async function defaultRunVersion(executable: string): Promise<string> {
  const result = await execFileAsync(executable, ["--version"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 5_000,
  });
  return result.stdout.trim() === "" ? result.stderr : result.stdout;
}

function versionLine(output: string): string | undefined {
  const value = output.split(/\r?\n/u)[0]?.trim();
  return value === undefined || value === "" ? undefined : value.slice(0, 200);
}

export class RuntimeAuditAdapter implements AuditAdapter {
  readonly id = "runtime";

  constructor(private readonly options: RuntimeAdapterOptions = {}) {}

  private executableNames(command: string): string[] {
    return this.options.platform === "win32"
      ? [`${command}.exe`, `${command}.cmd`, command]
      : [command];
  }

  private async resolveCommand(command: string): Promise<string | undefined> {
    const environment = this.options.environment ?? process.env;
    const pathValue = environment.PATH ?? environment.Path;
    if (pathValue === undefined || pathValue === "") {
      return undefined;
    }
    for (const directory of pathValue.split(delimiter)) {
      if (directory === "") {
        continue;
      }
      for (const name of this.executableNames(command)) {
        const candidate = resolve(directory, name);
        try {
          const stats = await lstat(candidate);
          if (stats.isFile() || stats.isSymbolicLink()) {
            if (this.options.platform !== "win32") {
              try {
                await access(candidate, constants.X_OK);
              } catch (error) {
                if (isUnavailableExecutable(error)) {
                  continue;
                }
                throw error;
              }
            }
            return candidate;
          }
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
        }
      }
    }
    return undefined;
  }

  private async discovered(context: AuditContext): Promise<boolean> {
    for (const runtime of RUNTIMES) {
      if ((await this.resolveCommand(runtime.command)) !== undefined) {
        return true;
      }
    }
    try {
      const stats = await lstat(join(context.home, ".local", "share", "claude", "versions"));
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async probe(context: AuditContext): Promise<AdapterProbe> {
    try {
      return (await this.discovered(context))
        ? {
            adapter: this.id,
            status: "available",
            detail: "Agent runtime installations found",
            diagnostics: [],
          }
        : {
            adapter: this.id,
            status: "absent",
            detail: "No supported agent runtime installation found",
            diagnostics: [],
          };
    } catch (error) {
      return {
        adapter: this.id,
        status: "degraded",
        detail: "Agent runtime installations could not be inspected",
        diagnostics: [
          {
            severity: "warning",
            code: "RUNTIME_PROBE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            adapter: this.id,
          },
        ],
      };
    }
  }

  private resource(
    context: AuditContext,
    input: {
      tool: string;
      displayName: string;
      path: string;
      measuredBytes?: number;
      facts: Record<string, unknown>;
    },
  ): ResourceSnapshot {
    const path = resolve(input.path);
    const canonicalKey = `runtime:agent-runtime:${input.tool}:${path}`;
    return {
      resource: {
        id: `runtime:agent-runtime:${sha256(canonicalKey)}`,
        adapter: this.id,
        kind: "agent-runtime",
        canonicalKey,
        displayName: input.displayName,
        path,
      },
      observedAt: context.now.toISOString(),
      exists: true,
      ...(input.measuredBytes === undefined ? {} : { measuredBytes: input.measuredBytes }),
      facts: {
        tool: input.tool,
        reportOnly: true,
        ...input.facts,
      },
    };
  }

  private async collectClaudeNative(
    context: AuditContext,
    activeExecutable: string | undefined,
  ): Promise<{ resources: ResourceSnapshot[]; paths: Set<string>; diagnostics: Diagnostic[] }> {
    const root = join(context.home, ".local", "share", "claude", "versions");
    const resources: ResourceSnapshot[] = [];
    const paths = new Set<string>();
    const diagnostics: Diagnostic[] = [];
    let activePath: string | undefined;
    if (activeExecutable !== undefined) {
      try {
        activePath = await realpath(activeExecutable);
      } catch {
        activePath = undefined;
      }
    }

    try {
      const rootStats = await lstat(root);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        diagnostics.push({
          severity: "warning",
          code: "CLAUDE_RUNTIME_ROOT_UNSAFE",
          message: "Claude native version root must be a real directory.",
          adapter: this.id,
        });
        return { resources, paths, diagnostics };
      }
      for (const entry of await readdir(root, { withFileTypes: true })) {
        context.signal?.throwIfAborted();
        if (!entry.isFile()) {
          continue;
        }
        const path = await realpath(resolve(root, entry.name));
        const stats = await lstat(path);
        paths.add(path);
        resources.push(
          this.resource(context, {
            tool: "claude",
            displayName: `Claude Code ${entry.name}`,
            path,
            measuredBytes: stats.size,
            facts: {
              version: entry.name,
              selected: activePath === path,
              installManager: "claude-native",
              recommendation: "Use `claude install stable` to manage this installation.",
              mtimeMs: stats.mtimeMs,
            },
          }),
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        diagnostics.push({
          severity: "warning",
          code: "CLAUDE_RUNTIME_INSPECTION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
      }
    }
    return { resources, paths, diagnostics };
  }

  async collect(context: AuditContext, probe: AdapterProbe): Promise<CollectionResult> {
    if (probe.status !== "available") {
      return { resources: [], diagnostics: [] };
    }
    const resources: ResourceSnapshot[] = [];
    const diagnostics: Diagnostic[] = [];
    const resolved = new Map<string, string>();
    for (const runtime of RUNTIMES) {
      const executable = await this.resolveCommand(runtime.command);
      if (executable !== undefined) {
        resolved.set(runtime.tool, executable);
      }
    }

    const claudeNative = await this.collectClaudeNative(context, resolved.get("claude"));
    resources.push(...claudeNative.resources);
    diagnostics.push(...claudeNative.diagnostics);

    for (const runtime of RUNTIMES) {
      context.signal?.throwIfAborted();
      const launcherPath = resolved.get(runtime.tool);
      if (launcherPath === undefined) {
        continue;
      }
      let executablePath: string;
      try {
        executablePath = await realpath(launcherPath);
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "RUNTIME_EXECUTABLE_UNREADABLE",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
        continue;
      }
      const stats = await lstat(executablePath);
      if (!stats.isFile()) {
        diagnostics.push({
          severity: "warning",
          code: "RUNTIME_EXECUTABLE_INVALID",
          message: "Resolved runtime executable is not a regular file.",
          adapter: this.id,
        });
        continue;
      }
      if (runtime.tool === "claude" && claudeNative.paths.has(executablePath)) {
        continue;
      }
      let version: string | undefined;
      try {
        version = versionLine(await (this.options.runVersion ?? defaultRunVersion)(executablePath));
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "RUNTIME_VERSION_FAILED",
          message: error instanceof Error ? error.message : String(error),
          adapter: this.id,
        });
      }
      resources.push(
        this.resource(context, {
          tool: runtime.tool,
          displayName: runtime.displayName,
          path: executablePath,
          measuredBytes: stats.size,
          facts: {
            selected: true,
            launcherPath,
            executablePath,
            installManager: "unknown",
            recommendation: "Use the owning installer or package manager for updates and removal.",
            ...(version === undefined ? {} : { version }),
            mtimeMs: stats.mtimeMs,
          },
        }),
      );
    }

    resources.sort((left, right) =>
      left.resource.canonicalKey.localeCompare(right.resource.canonicalKey),
    );
    return { resources, diagnostics };
  }

  async classify(context: AuditContext, resource: ResourceSnapshot): Promise<Finding> {
    const observedAt = context.now.toISOString();
    return {
      schemaVersion: 1,
      findingId: `${resource.resource.id}:${sha256(context.auditId)}`,
      auditId: context.auditId,
      observedAt,
      resource: resource.resource,
      state: "protected",
      confidence: "certain",
      roots: [
        {
          code: "runtime-owner-report-only",
          source: this.id,
          observedAt,
          detail: "Agent runtime maintenance remains owned by its installer or package manager.",
        },
      ],
      facts: resource.facts,
      candidateActions: [],
      ...(resource.measuredBytes === undefined ? {} : { measuredBytes: resource.measuredBytes }),
      warnings: [],
    };
  }
}
