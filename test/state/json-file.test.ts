import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  ensurePrivateDirectories,
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
  inheritance: number;
  propagation: number;
  inherited: boolean;
};

type WindowsAcl = {
  currentUserSid: string;
  ownerSid: string;
  protected: boolean;
  access: WindowsAclRule[];
};

const inspectWindowsAclCommand = `
$ErrorActionPreference = 'Stop'
$decodedDirectories = ConvertFrom-Json -InputObject ([Environment]::GetEnvironmentVariable('AGENTRINSE_TEST_DIRECTORIES'))
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$results = @(foreach ($directory in $decodedDirectories) {
  $acl = [System.IO.DirectoryInfo]::new([string]$directory).GetAccessControl()
  [pscustomobject]@{
    currentUserSid = $currentUser
    ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    protected = $acl.AreAccessRulesProtected
    access = @($acl.Access | ForEach-Object {
      [pscustomobject]@{
        sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        type = $_.AccessControlType.ToString()
        rights = [int]$_.FileSystemRights
        inheritance = [int]$_.InheritanceFlags
        propagation = [int]$_.PropagationFlags
        inherited = $_.IsInherited
      }
    })
  }
})
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`;

async function inspectWindowsAcls(directories: readonly string[]): Promise<WindowsAcl[]> {
  const { stdout } = await execFileAsync(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inspectWindowsAclCommand],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTRINSE_TEST_DIRECTORIES: JSON.stringify(directories),
      },
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as WindowsAcl[];
}

async function setWindowsDirectoryOwner(directory: string, ownerSid: string): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  windowsPowerShellExecutable(systemRoot);
  await execFileAsync(join(systemRoot!, "System32", "icacls.exe"), [
    directory,
    "/setowner",
    `*${ownerSid}`,
    "/Q",
  ]);
}

async function expectPosixMode(path: string, expected: number): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(expected);
  }
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

  it("preflights every private directory before changing existing permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-private-preflight-"));
    const valid = join(root, "valid");
    const target = join(root, "target");
    const invalid = join(root, "invalid");
    await mkdir(valid, { mode: 0o755 });
    await mkdir(target);
    await chmod(valid, 0o755);
    await symlink(target, invalid, process.platform === "win32" ? "junction" : "dir");
    const [before] = process.platform === "win32" ? await inspectWindowsAcls([valid]) : [];

    await expect(ensurePrivateDirectories([valid, invalid, valid])).rejects.toThrow();

    if (before === undefined) {
      await expectPosixMode(valid, 0o755);
    } else {
      expect(await inspectWindowsAcls([valid])).toEqual([before]);
    }
  });

  it("does not create missing directories when a later preflight entry is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentrinse-private-create-preflight-"));
    const missing = join(root, "missing");
    const target = join(root, "target");
    const invalid = join(root, "invalid");
    await mkdir(target);
    await symlink(target, invalid, process.platform === "win32" ? "junction" : "dir");

    await expect(ensurePrivateDirectories([missing, invalid])).rejects.toThrow();

    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32")(
    "rejects a foreign-owned batch before creating any missing directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agentrinse-private-owner-preflight-"));
      const missingBefore = join(root, "missing-before");
      const foreignOwned = join(root, "foreign-owned");
      const missingAfter = join(root, "missing-after");
      await mkdir(foreignOwned);
      const [originalAcl] = await inspectWindowsAcls([foreignOwned]);
      if (originalAcl === undefined) {
        throw new Error("expected the synthetic Windows directory ACL");
      }

      try {
        await setWindowsDirectoryOwner(foreignOwned, "S-1-5-18");

        await expect(
          ensurePrivateDirectories([missingBefore, foreignOwned, missingAfter]),
        ).rejects.toThrow("not owned by the current user or local Administrators");
        await expect(lstat(missingBefore)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(missingAfter)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await setWindowsDirectoryOwner(foreignOwned, originalAcl.ownerSid);
      }
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "repairs and verifies exact ACLs for a private directory batch",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agentrinse-private-state-windows-"));
      const plans = join(root, "plans");

      await writeJsonAtomic(
        join(plans, "plan.json"),
        { planId: "plan-1" },
        { privateDirectories: [root, plans] },
      );

      const acls = await inspectWindowsAcls([root, plans]);
      expect(acls).toHaveLength(2);
      for (const acl of acls) {
        expect([acl.currentUserSid, "S-1-5-32-544"]).toContain(acl.ownerSid);
        expect(acl.protected).toBe(true);
        expect(acl.access).toHaveLength(3);
        expect(acl.access).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sid: acl.currentUserSid,
              type: "Allow",
              rights: 2_032_127,
              inheritance: 3,
              propagation: 0,
            }),
            expect.objectContaining({
              sid: "S-1-5-18",
              type: "Allow",
              rights: 2_032_127,
              inheritance: 3,
              propagation: 0,
            }),
            expect.objectContaining({
              sid: "S-1-5-32-544",
              type: "Allow",
              rights: 2_032_127,
              inheritance: 3,
              propagation: 0,
            }),
          ]),
        );
        expect(acl.access.every((rule) => !rule.inherited)).toBe(true);
      }
    },
  );
});
