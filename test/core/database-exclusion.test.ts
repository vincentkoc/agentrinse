import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { acquireDatabaseExclusion } from "../../src/core/database-exclusion.js";

const execFileAsync = promisify(execFile);
const hasSqlite = (() => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("database exclusion", () => {
  it.runIf(hasSqlite)("blocks SQLite readers and writers until release", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-db-lock-"));
    const path = join(root, "state_5.sqlite");
    await execFileAsync("sqlite3", [
      path,
      "PRAGMA journal_mode=WAL; CREATE TABLE values_table(value INTEGER); INSERT INTO values_table VALUES(1); PRAGMA wal_checkpoint(TRUNCATE);",
    ]);

    const exclusion = await acquireDatabaseExclusion([path]);
    expect((await lstat(path)).mode & 0o222).toBe(0);
    await expect(
      execFileAsync("sqlite3", [
        "-batch",
        "-cmd",
        ".timeout 0",
        path,
        "SELECT * FROM values_table;",
      ]),
    ).rejects.toMatchObject({ code: 5 });
    const waitingWrite = execFileAsync("sqlite3", [
      "-batch",
      "-cmd",
      ".timeout 2000",
      path,
      "INSERT INTO values_table VALUES(2);",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await exclusion.release();
    await expect(waitingWrite).rejects.toBeDefined();
    expect((await lstat(path)).mode & 0o200).toBe(0o200);
    await expect(
      execFileAsync("sqlite3", ["-batch", path, "SELECT count(*) FROM values_table;"]),
    ).resolves.toMatchObject({ stdout: "1\n" });
  });
});
