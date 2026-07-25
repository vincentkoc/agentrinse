import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  codexDatabaseContractMatches,
  inspectCodexDatabase,
  inspectCodexProcesses,
  inspectDatabaseOpenHandles,
  vacuumCodexDatabaseInto,
  verifyCodexDatabaseIntegrity,
} from "../../src/adapters/codex-database.js";

describe("Codex database inspection", () => {
  it("reads a supported state database contract without opening provider content", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-codex-db-"));
    const path = join(root, "state_5.sqlite");
    const header = Buffer.alloc(100);
    header.write("SQLite format 3\0", "binary");
    header[18] = 2;
    header[19] = 2;
    await writeFile(path, header);
    const queries: string[] = [];

    const inspection = await inspectCodexDatabase(path, {
      async runSqlite(args) {
        const sql = args.at(-1) ?? "";
        queries.push(sql);
        if (sql.includes("pragma_page_size")) {
          return { stdout: "4096\n200000\n150000\n0\nok\n", stderr: "" };
        }
        if (sql.includes("type = 'table'")) {
          return { stdout: "_sqlx_migrations\nthreads\n", stderr: "" };
        }
        if (sql.includes("success != 1")) {
          return { stdout: "0\n", stderr: "" };
        }
        if (sql.includes("max(version)")) {
          return { stdout: "39\n", stderr: "" };
        }
        return {
          stdout:
            "index\u001fidx_threads\u001fthreads\u001fCREATE INDEX idx_threads ON threads(id)\n" +
            "table\u001f_sqlx_migrations\u001f_sqlx_migrations\u001fCREATE TABLE _sqlx_migrations(version INTEGER)\n" +
            "table\u001fthreads\u001fthreads\u001fCREATE TABLE threads(id TEXT)\n",
          stderr: "",
        };
      },
    });

    expect(inspection.identity.database).toBe("state");
    expect(inspection.identity.migrationVersion).toBe(39);
    expect(inspection.estimatedReclaimBytes).toBe(614_400_000);
    expect(inspection.freePageRatio).toBe(0.75);
    expect(codexDatabaseContractMatches(inspection.identity)).toBe(true);
    expect(queries.join("\n")).not.toContain("SELECT *");
  });

  it("rejects a database with a failed SQLx migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-codex-db-failed-migration-"));
    const path = join(root, "state_5.sqlite");
    const header = Buffer.alloc(100);
    header.write("SQLite format 3\0", "binary");
    header[18] = 2;
    header[19] = 2;
    await writeFile(path, header);

    await expect(
      inspectCodexDatabase(path, {
        async runSqlite(args) {
          const sql = args.at(-1) ?? "";
          if (sql.includes("pragma_page_size")) {
            return { stdout: "4096\n200000\n150000\n0\nok\n", stderr: "" };
          }
          if (sql.includes("type = 'table'")) {
            return { stdout: "_sqlx_migrations\nthreads\n", stderr: "" };
          }
          if (sql.includes("success != 1")) {
            return { stdout: "1\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("failed SQLx migration");
  });

  it("uses long operation-specific timeouts for compaction and integrity checks", async () => {
    const timeouts: number[] = [];
    const runSqlite = async (
      args: string[],
      options?: { timeoutMs: number },
    ): Promise<{ stdout: string; stderr: string }> => {
      timeouts.push(options?.timeoutMs ?? 0);
      return {
        stdout: (args.at(-1) ?? "").includes("integrity_check") ? "ok\n" : "",
        stderr: "",
      };
    };

    await vacuumCodexDatabaseInto("/fixture/state_5.sqlite", "/fixture/output.sqlite", {
      runSqlite,
    });
    await verifyCodexDatabaseIntegrity("/fixture/output.sqlite", { runSqlite });

    expect(timeouts).toEqual([2 * 60 * 60_000, 2 * 60 * 60_000, 30 * 60_000]);
  });

  it("parses exact database descriptors and Codex owner processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-codex-handles-"));
    const path = join(root, "state_5.sqlite");
    await writeFile(path, "synthetic");
    const handles = await inspectDatabaseOpenHandles(path, {
      async runLsof() {
        return { stdout: `p42\nccodex\nn${path}\n`, stderr: "" };
      },
    });
    const processes = await inspectCodexProcesses({
      async runPs() {
        return {
          stdout:
            "   42 Codex /Applications/Codex.app/Contents/MacOS/Codex\n" +
            "   43 node node ./worker.js\n",
          stderr: "",
        };
      },
    });

    expect(handles).toEqual({ status: "busy", pids: [42] });
    expect(processes).toEqual({ status: "busy", pids: [42] });
  });
});
