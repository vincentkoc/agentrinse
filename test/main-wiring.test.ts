import { homedir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests pin how the CLI maps flags onto each command handler. The
// handlers are mocked, so nothing here reads or writes a real home.
const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  plan: vi.fn(),
  clean: vi.fn(),
  apply: vi.fn(),
  doctor: vi.fn(),
  configPath: vi.fn(),
  configInit: vi.fn(),
  configShow: vi.fn(),
  configValidate: vi.fn(),
  history: vi.fn(),
  undo: vi.fn(),
  purge: vi.fn(),
  showRun: vi.fn(),
  showPlan: vi.fn(),
  showResource: vi.fn(),
  lockStatus: vi.fn(),
  lockRecover: vi.fn(),
}));

vi.mock("../src/commands/audit.js", () => ({ executeAuditCommand: mocks.audit }));
vi.mock("../src/commands/plan.js", () => ({ executePlanCommand: mocks.plan }));
vi.mock("../src/commands/clean.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commands/clean.js")>()),
  executeCleanCommand: mocks.clean,
}));
vi.mock("../src/commands/apply.js", () => ({ executeApplyCommand: mocks.apply }));
vi.mock("../src/commands/doctor.js", () => ({ executeDoctorCommand: mocks.doctor }));
vi.mock("../src/commands/config.js", () => ({
  executeConfigPathCommand: mocks.configPath,
  executeConfigInitCommand: mocks.configInit,
  executeConfigShowCommand: mocks.configShow,
  executeConfigValidateCommand: mocks.configValidate,
}));
vi.mock("../src/commands/history.js", () => ({ executeHistoryCommand: mocks.history }));
vi.mock("../src/commands/undo.js", () => ({ executeUndoCommand: mocks.undo }));
vi.mock("../src/commands/purge.js", () => ({ executePurgeCommand: mocks.purge }));
vi.mock("../src/commands/show.js", () => ({
  executeShowRunCommand: mocks.showRun,
  executeShowPlanCommand: mocks.showPlan,
  executeShowResourceCommand: mocks.showResource,
}));
vi.mock("../src/commands/lock.js", () => ({
  executeLockStatusCommand: mocks.lockStatus,
  executeLockRecoverCommand: mocks.lockRecover,
}));

const { buildProgram, main } = await import("../src/main.js");

const HOME = "/synthetic/home";
let stdout: string[];

async function run(...args: string[]): Promise<void> {
  await buildProgram()
    .exitOverride()
    .parseAsync(["node", "agentrinse", ...args], { from: "node" });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("audit", () => {
  it("maps --no-state and --home, passes an abort signal, and writes the output", async () => {
    mocks.audit.mockResolvedValue({ output: "report\n" });
    const listeners = process.listenerCount("SIGINT");

    await run("audit", "--home", HOME, "--json", "--no-state", "--quick", "--providers", "codex");

    expect(mocks.audit).toHaveBeenCalledOnce();
    const input = mocks.audit.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      home: HOME,
      json: true,
      quick: true,
      providers: "codex",
      noState: true,
      state: false,
    });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.emit).toBeUndefined();
    expect(stdout.join("")).toBe("report\n");
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });

  it("defaults --home to the user's home and streams NDJSON through emit", async () => {
    mocks.audit.mockImplementation(async (input: { emit: (line: string) => void }) => {
      input.emit('{"event":"x"}\n');
      return { output: "" };
    });

    await run("audit", "--ndjson", "--no-state");

    const input = mocks.audit.mock.calls[0]?.[0];
    expect(input.home).toBe(homedir());
    expect(input.noState).toBe(true);
    expect(stdout).toEqual(['{"event":"x"}\n']);
  });

  it("keeps state by default", async () => {
    mocks.audit.mockResolvedValue({ output: "" });
    await run("audit", "--home", HOME);
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({ noState: false, state: true });
    expect(stdout).toEqual([]);
  });

  it("removes its SIGINT listener when the audit fails", async () => {
    mocks.audit.mockRejectedValue(new Error("boom"));
    const listeners = process.listenerCount("SIGINT");
    await expect(run("audit", "--home", HOME)).rejects.toThrow("boom");
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  });
});

describe("plan", () => {
  it("passes the audit path and risk ceiling", async () => {
    mocks.plan.mockResolvedValue({ output: "plan\n" });
    await run("plan", "--audit", "/a.json", "--max-risk", "safe", "--state-dir", "/s");
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.objectContaining({ audit: "/a.json", maxRisk: "safe", stateDir: "/s" }),
    );
    expect(stdout.join("")).toBe("plan\n");
  });
});

describe("clean", () => {
  it("rejects unknown profiles before running", async () => {
    await expect(run("clean", "--profile", "everything")).rejects.toThrow(
      "unsupported clean profile: everything",
    );
    expect(mocks.clean).not.toHaveBeenCalled();
  });

  it("runs the closeout profile by default without repos", async () => {
    mocks.clean.mockResolvedValue({ output: "ok\n", status: "ok" });
    await run("clean", "--home", HOME, "--json");
    const input = mocks.clean.mock.calls[0]?.[0];
    expect(input).toMatchObject({ profile: "closeout", home: HOME, json: true });
    expect(input).not.toHaveProperty("repos");
    expect(stdout.join("")).toBe("ok\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("passes repeated --repo values to the fleet profile", async () => {
    mocks.clean.mockResolvedValue({ output: "", status: "ok" });
    await run("clean", "--profile", "fleet", "--repo", "/r1", "--repo", "/r2", "--home", HOME);
    expect(mocks.clean.mock.calls[0]?.[0]).toMatchObject({
      profile: "fleet",
      repos: ["/r1", "/r2"],
    });
  });

  it.each([
    [{ status: "degraded" }, 1],
    [{ status: "ok", run: { status: "partial" } }, 2],
    [{ status: "ok", run: { status: "interrupted" } }, 130],
  ])("sets the exit code for %o", async (result, code) => {
    mocks.clean.mockResolvedValue({ output: "", ...result });
    await run("clean", "--home", HOME);
    expect(process.exitCode).toBe(code);
  });
});

describe("apply", () => {
  it.each([
    ["completed", undefined],
    ["failed", 2],
    ["partial", 2],
    ["interrupted", 130],
  ])("maps run status %s to exit code %s", async (status, code) => {
    mocks.apply.mockResolvedValue({ output: "journal\n", run: { status } });
    await run("apply", "--plan", "/p.json", "--yes");
    expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({ plan: "/p.json", yes: true });
    expect(mocks.apply.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(stdout.join("")).toBe("journal\n");
    expect(process.exitCode).toBe(code);
  });
});

describe("informational commands", () => {
  it("lists adapters", async () => {
    await run("adapters");
    expect(stdout.join("")).not.toBe("");
  });

  it("renders shell completion", async () => {
    await run("completion", "bash");
    expect(stdout.join("")).toContain("agentrinse");
  });

  it("exits 1 when doctor reports an error", async () => {
    mocks.doctor.mockResolvedValue({ output: "bad\n", report: { status: "error" } });
    await run("doctor", "--home", HOME, "--json");
    expect(mocks.doctor).toHaveBeenCalledWith(expect.objectContaining({ home: HOME, json: true }));
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code alone when doctor is healthy", async () => {
    mocks.doctor.mockResolvedValue({ output: "ok\n", report: { status: "ok" } });
    await run("doctor");
    expect(mocks.doctor.mock.calls[0]?.[0].home).toBe(homedir());
    expect(process.exitCode).toBeUndefined();
  });
});

describe("config", () => {
  it.each([
    ["path", mocks.configPath],
    ["init", mocks.configInit],
    ["show", mocks.configShow],
    ["validate", mocks.configValidate],
  ])("config %s passes home and config", async (subcommand, mock) => {
    mock.mockReturnValue({ output: `${subcommand}\n` });
    await run("config", subcommand, "--home", HOME, "--config", "/c.json");
    expect(mock).toHaveBeenCalledWith({ home: HOME, config: "/c.json" });
    expect(stdout.join("")).toBe(`${subcommand}\n`);
  });
});

describe("state commands", () => {
  it("history passes --since", async () => {
    mocks.history.mockResolvedValue({ output: "h\n" });
    await run("history", "--home", HOME, "--since", "30d", "--json");
    expect(mocks.history).toHaveBeenCalledWith(
      expect.objectContaining({ home: HOME, since: "30d", json: true }),
    );
  });

  it("undo maps --action to actionId and omits unset options", async () => {
    mocks.undo.mockResolvedValue({ output: "u\n" });
    await run("undo", "run-1", "--home", HOME, "--action", "act-1", "--yes");
    expect(mocks.undo).toHaveBeenCalledWith({
      runId: "run-1",
      home: HOME,
      yes: true,
      json: false,
      actionId: "act-1",
    });

    mocks.undo.mockClear();
    await run("undo", "run-2", "--home", HOME, "--config", "/c.json", "--state-dir", "/s");
    expect(mocks.undo).toHaveBeenCalledWith({
      runId: "run-2",
      home: HOME,
      yes: false,
      json: false,
      config: "/c.json",
      stateDir: "/s",
    });
  });

  it("purge maps --run to runId and keeps preview as the default", async () => {
    mocks.purge.mockResolvedValue({ output: "p\n" });
    await run("purge", "--home", HOME, "--run", "run-1");
    expect(mocks.purge).toHaveBeenCalledWith({
      home: HOME,
      expired: false,
      apply: false,
      yes: false,
      json: false,
      runId: "run-1",
    });
  });

  it.each([
    ["run", mocks.showRun],
    ["plan", mocks.showPlan],
    ["resource", mocks.showResource],
  ])("show %s passes the id and options", async (kind, mock) => {
    mock.mockResolvedValue({ output: `${kind}\n` });
    await run("show", kind, "id-1", "--home", HOME, "--json");
    expect(mock).toHaveBeenCalledWith("id-1", expect.objectContaining({ home: HOME, json: true }));
    expect(stdout.join("")).toBe(`${kind}\n`);
  });

  it("lock status and recover pass their options", async () => {
    mocks.lockStatus.mockResolvedValue({ output: "s\n" });
    mocks.lockRecover.mockResolvedValue({ output: "r\n" });
    await run("lock", "status", "--home", HOME, "--json");
    await run("lock", "recover", "--home", HOME, "--yes");
    expect(mocks.lockStatus).toHaveBeenCalledWith(
      expect.objectContaining({ home: HOME, json: true }),
    );
    expect(mocks.lockRecover).toHaveBeenCalledWith(
      expect.objectContaining({ home: HOME, yes: true }),
    );
    expect(stdout.join("")).toBe("s\nr\n");
  });
});

describe("main", () => {
  it("parses process-style argv", async () => {
    await main(["node", "agentrinse", "adapters"]);
    expect(stdout.join("")).not.toBe("");
  });
});
