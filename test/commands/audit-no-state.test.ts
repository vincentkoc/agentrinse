import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { executeAuditCommand, parseAuditProviders } from "../../src/commands/audit.js";
import { executePlanCommand } from "../../src/commands/plan.js";
import { commandEnvelopeSchema, commandEventSchema } from "../../src/contracts/output.js";
import { auditReportSchema } from "../../src/contracts/report.js";

type TreeEntry = {
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  mode: number;
  size: string;
  modified: string;
  changed: string;
  inode: string;
  content?: string;
};

async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const stats = await lstat(path, { bigint: true });
    const kind = stats.isDirectory()
      ? "directory"
      : stats.isFile()
        ? "file"
        : stats.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({
      path: relative(root, path) || ".",
      kind,
      mode: Number(stats.mode),
      size: stats.size.toString(),
      modified: stats.mtimeNs.toString(),
      changed: stats.ctimeNs.toString(),
      inode: stats.ino.toString(),
      ...(kind === "file"
        ? {
            content: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          }
        : {}),
    });
    if (kind === "directory") {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name));
      }
    }
  };
  await visit(root);
  return entries;
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("stateless provider audit", () => {
  it("rejects persistence options and non-machine output before discovery", async () => {
    const missingHome = join(tmpdir(), `agentrinse-missing-${randomUUID()}`);
    const missingConfig = join(missingHome, "missing-config.json");
    const emitted: string[] = [];

    await expect(
      executeAuditCommand({
        home: missingHome,
        config: missingConfig,
        noState: true,
        ndjson: true,
        output: join(missingHome, "audit.json"),
        emit: (record) => emitted.push(record),
      }),
    ).rejects.toThrow("does not accept --output");
    await expect(
      executeAuditCommand({
        home: missingHome,
        config: missingConfig,
        noState: true,
        json: true,
        stateDir: join(missingHome, "state"),
      }),
    ).rejects.toThrow("does not accept --state-dir");
    await expect(
      executeAuditCommand({
        home: missingHome,
        noState: true,
      }),
    ).rejects.toThrow("requires --json or --ndjson");
    await expect(
      executeAuditCommand({
        home: missingHome,
        config: missingConfig,
        json: true,
        providers: "cursor",
      }),
    ).rejects.toThrow("--providers requires --no-state");
    expect(emitted).toEqual([]);
  });

  it("rejects empty, duplicate, unknown, and non-provider selections", () => {
    expect(() => parseAuditProviders("")).toThrow("non-empty");
    expect(() => parseAuditProviders("cursor,")).toThrow("empty provider ID");
    expect(() => parseAuditProviders("cursor,cursor")).toThrow("duplicate provider");
    expect(() => parseAuditProviders("cursor, copilot")).toThrow("without whitespace");
    expect(() => parseAuditProviders("git")).toThrow("provider IDs only");
    expect(() => parseAuditProviders("not-a-provider")).toThrow("unknown provider");
  });

  it("rejects a selected disabled provider with a relative configured root", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-relative-provider-root-"));
    const configPath = join(home, "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        adapters: {
          cursor: {
            enabled: false,
            root: "relative/cursor",
          },
        },
      })}\n`,
    );

    await expect(
      executeAuditCommand({
        home,
        config: configPath,
        noState: true,
        json: true,
        providers: "cursor",
      }),
    ).rejects.toThrow("requires an absolute configured root for cursor");
    await expectMissing(join(home, "relative", "cursor"));
    await expectMissing(join(home, ".local", "state", "agentrinse"));
  });

  it("emits NDJSON without resolving a state path", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-stateless-ndjson-"));
    const result = await executeAuditCommand({
      home,
      noState: true,
      ndjson: true,
      providers: "cursor",
    });
    const events = result.output
      .trim()
      .split("\n")
      .map((line) => commandEventSchema.parse(JSON.parse(line)));

    expect(Object.hasOwn(result, "statePath")).toBe(false);
    expect(events[0]?.event).toBe("command.started");
    expect(events.at(-1)?.event).toBe("command.completed");
    await expectMissing(join(home, ".local", "state", "agentrinse"));
  });

  it("omits candidate actions from JSON, NDJSON, and extracted plans", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-stateless-actions-"));
    const claudeRoot = join(home, "claude");
    const debugRoot = join(claudeRoot, "debug");
    const configPath = join(home, "config.json");
    const extractedAuditPath = join(home, "extracted-audit.json");
    const now = () => new Date("2026-08-07T00:00:00.000Z");
    await mkdir(debugRoot, { recursive: true });
    const debugLog = join(debugRoot, "old-session.txt");
    await writeFile(debugLog, "synthetic old debug output\n");
    await utimes(
      debugLog,
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-01T00:00:00.000Z"),
    );
    await writeFile(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        adapters: {
          claude: {
            enabled: false,
            root: claudeRoot,
          },
        },
        plan: {
          ttlMinutes: 30,
          maxRisk: "recoverable",
        },
      })}\n`,
    );

    const json = await executeAuditCommand({
      home,
      config: configPath,
      noState: true,
      json: true,
      providers: "claude",
      now,
    });
    const envelope = commandEnvelopeSchema.parse(JSON.parse(json.output));
    const envelopeReport = auditReportSchema.parse(envelope.data);
    const eligible = json.report.findings.find((finding) => finding.state === "eligible");

    expect(Object.hasOwn(json, "statePath")).toBe(false);
    expect(eligible).toBeDefined();
    expect(eligible?.candidateActions).toEqual([]);
    expect(envelopeReport.findings.every((finding) => finding.candidateActions.length === 0)).toBe(
      true,
    );

    const ndjson = await executeAuditCommand({
      home,
      config: configPath,
      noState: true,
      ndjson: true,
      providers: "claude",
      now,
    });
    const findingEvents = ndjson.output
      .trim()
      .split("\n")
      .map((line) => commandEventSchema.parse(JSON.parse(line)))
      .filter((event) => event.event === "finding.completed");
    expect(
      findingEvents.every(
        (event) =>
          typeof event.data === "object" &&
          event.data !== null &&
          "candidateActions" in event.data &&
          Array.isArray(event.data.candidateActions) &&
          event.data.candidateActions.length === 0,
      ),
    ).toBe(true);

    await writeFile(extractedAuditPath, `${JSON.stringify(json.report)}\n`);
    const plan = await executePlanCommand({
      audit: extractedAuditPath,
      config: configPath,
      stateDir: join(home, "plan-state"),
      maxRisk: "recoverable",
    });
    expect(plan.plan.actions).toEqual([]);
  });

  it("audits only selected providers without changing the synthetic home", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-stateless-home-"));
    const cursorRoot = join(home, "selected", "cursor");
    const copilotRoot = join(home, "selected", "copilot");
    const opencodeRoot = join(home, "selected", "opencode");
    const artifactRoot = join(home, "project");
    const configPath = join(home, "config.json");

    await mkdir(join(cursorRoot, "User", "workspaceStorage", "workspace"), {
      recursive: true,
    });
    await mkdir(join(cursorRoot, "User", "globalStorage"), { recursive: true });
    await mkdir(join(cursorRoot, "logs"), { recursive: true });
    await writeFile(join(cursorRoot, "User", "workspaceStorage", "workspace", "state.json"), "{}");
    await writeFile(join(cursorRoot, "User", "globalStorage", "state.vscdb"), "cursor");
    await mkdir(join(copilotRoot, "session-state"), { recursive: true });
    await mkdir(join(copilotRoot, "logs"), { recursive: true });
    await writeFile(join(copilotRoot, "session-state", "session.json"), "{}");
    await mkdir(join(opencodeRoot, "log"), { recursive: true });
    await mkdir(join(opencodeRoot, "snapshot"), { recursive: true });
    await writeFile(join(opencodeRoot, "opencode.db"), "opencode");
    await writeFile(join(opencodeRoot, "snapshot", "object"), "snapshot");

    await mkdir(join(home, "excluded-codex", "sessions"), { recursive: true });
    await writeFile(join(home, "excluded-codex", "sessions", "thread.jsonl"), "keep");
    await mkdir(join(home, "excluded-grok", "logs"), { recursive: true });
    await writeFile(join(home, "excluded-grok", "logs", "grok.log"), "keep");
    await mkdir(join(artifactRoot, "node_modules"), { recursive: true });
    await writeFile(join(artifactRoot, "node_modules", "cache"), "keep");

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          adapters: {
            codex: { enabled: true, root: join(home, "excluded-codex") },
            claude: { enabled: true, root: join(home, "excluded-claude") },
            cursor: { enabled: true, root: cursorRoot },
            copilot: { enabled: true, root: copilotRoot },
            zed: { enabled: true, root: join(home, "excluded-zed") },
            opencode: { enabled: true, root: opencodeRoot },
            grok: { enabled: true, root: join(home, "excluded-grok") },
            runtime: { enabled: true },
            git: { enabled: true, root: artifactRoot },
            docker: { enabled: true },
          },
          audit: {
            maxEntries: 1000,
            measureBytes: false,
          },
          artifacts: {
            projects: [{ root: artifactRoot, names: ["node_modules"] }],
            minAgeMinutes: 0,
            minBytes: 0,
            processCheck: "required",
          },
        },
        null,
        2,
      )}\n`,
    );

    const before = await snapshotTree(home);
    const result = await executeAuditCommand({
      home,
      config: configPath,
      noState: true,
      json: true,
      providers: "cursor,copilot,opencode",
    });
    const after = await snapshotTree(home);

    expect(Object.hasOwn(result, "statePath")).toBe(false);
    expect(result.report.probes.map((probe) => probe.adapter)).toEqual([
      "copilot",
      "cursor",
      "opencode",
    ]);
    expect(new Set(result.report.findings.map((finding) => finding.resource.adapter))).toEqual(
      new Set(["copilot", "cursor", "opencode"]),
    );
    expect(result.output).toContain(cursorRoot);
    expect(result.output).toContain(copilotRoot);
    expect(result.output).toContain(opencodeRoot);
    expect(result.output).not.toContain("excluded-codex");
    expect(result.output).not.toContain("excluded-grok");
    expect(result.output).not.toContain("node_modules");
    expect(after).toEqual(before);
    await expectMissing(join(home, ".local", "state", "agentrinse"));
  });
});
