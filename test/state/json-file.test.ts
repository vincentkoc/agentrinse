import { execFile } from "node:child_process";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  readJsonFile,
  syncDirectory,
  windowsPowerShellExecutable,
  writeJsonAtomic,
  writeJsonExclusive,
} from "../../src/state/json-file.js";

const execFileAsync = promisify(execFile);

type WindowsAclRule = {
  sid: string;
  type: string;
  rights: number;
  inherited: boolean;
};

type WindowsAcl = {
  currentUserSid: string;
  ownerSid: string;
  access: WindowsAclRule[];
};

const inspectWindowsAclCommand = `
$directory = [System.IO.DirectoryInfo]::new([Environment]::GetEnvironmentVariable('AGENTRINSE_TEST_DIRECTORY'))
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = $directory.GetAccessControl()
[pscustomobject]@{
  currentUserSid = $currentUser
  ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  access = @($acl.Access | ForEach-Object {
    [pscustomobject]@{
      sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      type = $_.AccessControlType.ToString()
      rights = [int]$_.FileSystemRights
      inherited = $_.IsInherited
    }
  })
} | ConvertTo-Json -Compress
`;

async function expectPosixMode(path: string, expected: number): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(expected);
  }
}

async function inspectWindowsAcl(directory: string): Promise<WindowsAcl> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inspectWindowsAclCommand],
    {
      encoding: "utf8",
      env: { ...process.env, AGENTRINSE_TEST_DIRECTORY: directory },
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as WindowsAcl;
}

describe("atomic JSON files", () => {
  it("resolves PowerShell from an absolute Windows system root", () => {
    expect(windowsPowerShellExecutable("C:\\Windows")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(() => windowsPowerShellExecutable("relative")).toThrow(
      "Windows SystemRoot is unavailable or not absolute",
    );
  });

  it("skips unsupported directory sync on Windows", async () => {
    await expect(
      syncDirectory(join(tmpdir(), "agentrinse-missing-directory"), "win32"),
    ).resolves.toBeUndefined();
  });

  it("writes a complete owner-only document", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-state-"));
    const path = join(root, "plans", "plan.json");

    await writeJsonAtomic(path, { planId: "plan-1" });

    expect(await readJsonFile(path)).toEqual({ planId: "plan-1" });
    await expectPosixMode(path, 0o600);
    await expectPosixMode(join(root, "plans"), 0o700);
  });

  it("does not change permissions on an existing parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-config-parent-"));
    await chmod(root, 0o755);

    await writeJsonExclusive(join(root, "config.json"), { schemaVersion: 1 });

    await expectPosixMode(root, 0o755);
    await expectPosixMode(join(root, "config.json"), 0o600);
  });

  it(
    "repairs and verifies AgentRinse-owned state directories",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agentrinse-private-state-"));
      const plans = join(root, "plans");
      await chmod(root, 0o777);

      await writeJsonAtomic(
        join(plans, "plan.json"),
        { planId: "plan-1" },
        {
          privateDirectories: [root, plans],
        },
      );

      await expectPosixMode(root, 0o700);
      await expectPosixMode(plans, 0o700);
    },
    process.platform === "win32" ? 30_000 : 10_000,
  );

  it.runIf(process.platform === "win32")(
    "removes inherited access from private state directories",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agentrinse-private-state-windows-"));
      const plans = join(root, "plans");

      await writeJsonAtomic(
        join(plans, "plan.json"),
        { planId: "plan-1" },
        { privateDirectories: [root, plans] },
      );

      for (const directory of [root, plans]) {
        const acl = await inspectWindowsAcl(directory);
        expect([acl.currentUserSid, "S-1-5-32-544"]).toContain(acl.ownerSid);
        expect(acl.access).toHaveLength(3);
        expect(acl.access).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ sid: acl.currentUserSid, type: "Allow", rights: 2_032_127 }),
            expect.objectContaining({ sid: "S-1-5-18", type: "Allow", rights: 2_032_127 }),
            expect.objectContaining({ sid: "S-1-5-32-544", type: "Allow", rights: 2_032_127 }),
          ]),
        );
        expect(acl.access.every((rule) => !rule.inherited)).toBe(true);
      }
    },
  );
});
