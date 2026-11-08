import { execFile, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import {
  bufferedGitRecordScanner,
  countIndexStatusSuppressedEntries,
  type GitRecordScanner,
  indexHasGitlink,
  streamingGitRecordScanner,
} from "../../src/adapters/git/index-scan.js";
import type { AuditContext } from "../../src/contracts/adapter.js";

const execFileAsync = promisify(execFile);
const LEGACY_MAX_BUFFER = 4 * 1024 * 1024;
const LARGE_INDEX_ENTRIES = 90_000;

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(" ")} failed: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

async function outputBytes(cwd: string, args: string[]): Promise<number> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return result.stdout.length;
}

/**
 * A clean repository whose index listings exceed the legacy 4 MiB buffer.
 * Every entry is skip-worktree, so no working files are written, and one
 * gitlink sorts after every other entry.
 */
async function createLargeIndexRepository(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agentrinse-git-index-"));
  const repo = join(home, "repo");
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "fixture@example.test"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "AgentRinse Fixture"]);
  const emptyBlob = (await gitWithInput(repo, ["hash-object", "-w", "--stdin"], "")).trim();
  const entries: string[] = [];
  for (let index = 0; index < LARGE_INDEX_ENTRIES; index += 1) {
    const directory = String(Math.floor(index / 100)).padStart(4, "0");
    const file = String(index % 100).padStart(3, "0");
    entries.push(
      `100644 ${emptyBlob}\tpackages/pkg-${directory}/src/module-file-number-${file}.ts`,
    );
  }
  entries.push(`160000 ${"1".repeat(emptyBlob.length)}\tzz/submodule`);
  await gitWithInput(repo, ["update-index", "--index-info"], `${entries.join("\n")}\n`);
  const paths = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1));
  await gitWithInput(repo, ["update-index", "-z", "--skip-worktree", "--stdin"], paths.join("\0"));
  await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return repo;
}

async function collectRecords(scan: GitRecordScanner, args: string[]): Promise<string[]> {
  const records: string[] = [];
  await scan(args, (record) => {
    records.push(record);
  });
  return records;
}

describe("git index record scanning", () => {
  it("adapts buffered runners and stops when the visitor asks", async () => {
    const scan = bufferedGitRecordScanner(async () => "a\0b\0\0c\0");
    const seen: string[] = [];

    await scan(["ls-files"], (record) => {
      seen.push(record);
      return record === "b";
    });

    expect(seen).toEqual(["a", "b"]);
  });

  it("reassembles records split across output chunks, including a final unterminated record", async () => {
    const scan = streamingGitRecordScanner({ executable: "sh", timeoutMs: 5_000 });

    await expect(
      collectRecords(scan, [
        "-c",
        "printf 'ab'; sleep 0.05; printf 'c\\000de'; sleep 0.05; printf 'f\\000tail'",
      ]),
    ).resolves.toEqual(["abc", "def", "tail"]);
  });

  it("stops the child as soon as the visitor has its answer", async () => {
    const scan = streamingGitRecordScanner({ executable: "sh", timeoutMs: 5_000 });
    const started = Date.now();
    let visited = 0;

    await scan(["-c", "printf 'first\\000wanted\\000'; sleep 30"], (record) => {
      visited += 1;
      return record === "wanted";
    });

    expect(visited).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a timeout as its own cause", async () => {
    const scan = streamingGitRecordScanner({ executable: "sh", timeoutMs: 100 });

    await expect(collectRecords(scan, ["-c", "sleep 30"])).rejects.toThrow(
      "Command timed out after 100ms: sh -c sleep 30",
    );
  });

  it("rejects non-zero exits with bounded stderr", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentrinse-git-index-"));
    const scan = streamingGitRecordScanner({ timeoutMs: 5_000 });

    await expect(
      collectRecords(scan, ["-C", join(home, "missing"), "ls-files", "-z", "-v"]),
    ).rejects.toThrow(/^Command failed: git -C .*missing ls-files -z -v/u);
  });

  it("rejects when the visitor throws", async () => {
    const scan = streamingGitRecordScanner({ executable: "sh", timeoutMs: 5_000 });

    await expect(
      scan(["-c", "printf 'bad\\000'; sleep 30"], () => {
        throw new Error("unexpected index record");
      }),
    ).rejects.toThrow("unexpected index record");
  });

  it(
    "inspects index listings larger than the legacy 4 MiB buffer",
    { timeout: 60_000 },
    async () => {
      const repo = await createLargeIndexRepository();
      expect(await outputBytes(repo, ["ls-files", "-z", "--stage"])).toBeGreaterThan(
        LEGACY_MAX_BUFFER,
      );
      expect(await outputBytes(repo, ["ls-files", "-z", "-v"])).toBeGreaterThan(LEGACY_MAX_BUFFER);
      const legacy = bufferedGitRecordScanner(
        async (args) =>
          (await execFileAsync("git", args, { encoding: "utf8", maxBuffer: LEGACY_MAX_BUFFER }))
            .stdout,
      );
      await expect(indexHasGitlink(legacy, repo)).rejects.toThrow(/maxBuffer/u);

      const scan = streamingGitRecordScanner({ timeoutMs: 60_000 });

      expect(await indexHasGitlink(scan, repo)).toBe(true);
      expect(await countIndexStatusSuppressedEntries(scan, repo)).toBe(LARGE_INDEX_ENTRIES + 1);
    },
  );

  it(
    "keeps a large clean repository in a fleet audit instead of failing the repository",
    { timeout: 60_000 },
    async () => {
      const repo = await createLargeIndexRepository();
      const adapter = new GitWorktreeAuditAdapter(
        repo,
        undefined,
        undefined,
        async () => ({ status: "idle", matches: [] }),
        undefined,
        {
          maxEntries: 10_000,
          measureBytes: false,
          gitTimeoutMs: 60_000,
          minAgeMinutes: 0,
          quarantineTtlMinutes: 60,
          platform: process.platform === "linux" ? "linux" : "darwin",
        },
        {
          isolateRepositoryFailure: true,
          mountProbe: async () => ({ status: "clear", paths: [] }),
        },
      );
      const context: AuditContext = {
        home: join(repo, ".."),
        now: new Date(),
        auditId: "audit-large-index",
      };

      const collection = await adapter.collect(context, await adapter.probe(context));

      expect(collection.diagnostics).toEqual([]);
      expect(collection.resources).toHaveLength(1);
      expect(collection.resources[0]!.facts).toMatchObject({
        isMain: true,
        hasSubmodules: true,
        statusSuppressedEntries: LARGE_INDEX_ENTRIES + 1,
      });
    },
  );
});
