import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, win32 as windowsPath } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const windowsPrivateDirectoriesEnvironmentVariable = "AGENTRINSE_PRIVATE_DIRECTORIES";
const windowsPrivateDirectoriesMaxJsonLength = 16_384;

const secureWindowsPrivateDirectoryCommand = `
$ErrorActionPreference = 'Stop'
$decodedPaths = ConvertFrom-Json -InputObject ([Environment]::GetEnvironmentVariable('${windowsPrivateDirectoriesEnvironmentVariable}'))
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$identities = @($currentUser, $system, $administrators) | Group-Object Value | ForEach-Object { $_.Group[0] }
$allowedSids = @($identities | ForEach-Object { $_.Value })
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl

function Resolve-PrivateDirectory {
  param([string] $Path, [switch] $AllowMissing)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException] {
    if ($AllowMissing) { return $null }
    throw "private state directory was not created: $Path"
  }
  if (-not ($item -is [System.IO.DirectoryInfo]) -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "private state path is not a real directory: $Path" }
  $directory = [System.IO.DirectoryInfo] $item
  $acl = $directory.GetAccessControl()
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (-not ($owner.Equals($currentUser) -or $owner.Equals($administrators))) { throw "private state directory is not owned by the current user or local Administrators: $($directory.FullName)" }
  [pscustomobject]@{ Directory = $directory; Acl = $acl }
}

$missingPaths = @(foreach ($path in $decodedPaths) {
  $entry = Resolve-PrivateDirectory -Path ([string] $path) -AllowMissing
  if ($null -eq $entry) { [string] $path }
})
foreach ($path in $missingPaths) {
  [void] [System.IO.Directory]::CreateDirectory($path)
}
$entries = @(foreach ($path in $decodedPaths) {
  Resolve-PrivateDirectory -Path ([string] $path)
})
foreach ($entry in $entries) {
  $entry.Acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($entry.Acl.Access)) { [void] $entry.Acl.RemoveAccessRuleAll($rule) }
  foreach ($sid in $identities) { $entry.Acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inheritance, $propagation, $allow)) }
  $entry.Directory.SetAccessControl($entry.Acl)
}
foreach ($entry in $entries) {
  $verified = $entry.Directory.GetAccessControl()
  $verifiedOwner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
  $rules = @($verified.Access)
  if (-not ($verifiedOwner.Equals($currentUser) -or $verifiedOwner.Equals($administrators)) -or -not $verified.AreAccessRulesProtected -or $rules.Count -ne $allowedSids.Count) { throw "private state directory ACL verification failed: $($entry.Directory.FullName)" }
  foreach ($sidValue in $allowedSids) {
    $matching = @($rules | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $sidValue })
    if ($matching.Count -ne 1 -or $matching[0].AccessControlType -ne $allow -or $matching[0].FileSystemRights -ne $full -or $matching[0].InheritanceFlags -ne $inheritance -or $matching[0].PropagationFlags -ne $propagation -or $matching[0].IsInherited) { throw "private state directory ACL verification failed: $($entry.Directory.FullName)" }
  }
}
`;

export function windowsPowerShellExecutable(systemRoot = process.env.SystemRoot): string {
  if (systemRoot === undefined || !windowsPath.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable or not absolute");
  }
  return windowsPath.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function syncDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // Windows does not support fsync on directory handles. State-file handles
  // are still synced before rename, and mutation remains blocked on Windows.
  if (platform === "win32") {
    return;
  }
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type JsonWriteOptions = {
  privateDirectories?: string[];
};

async function secureWindowsPrivateDirectories(directories: readonly string[]): Promise<void> {
  const serialized = JSON.stringify(directories);
  if (serialized.length > windowsPrivateDirectoriesMaxJsonLength) {
    throw new Error("private state directory batch exceeds the Windows environment limit");
  }
  await execFileAsync(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", secureWindowsPrivateDirectoryCommand],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        [windowsPrivateDirectoriesEnvironmentVariable]: serialized,
      },
      windowsHide: true,
    },
  );
}

async function inspectPrivateDirectory(directory: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`private state path is not a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`private state directory is not owned by the current user: ${directory}`);
  }
  return true;
}

export async function ensurePrivateDirectories(directories: readonly string[]): Promise<void> {
  const uniqueDirectories = [...new Set(directories)];
  if (uniqueDirectories.length === 0) {
    return;
  }
  if (process.platform === "win32") {
    await secureWindowsPrivateDirectories(uniqueDirectories);
    return;
  }
  const existingDirectories = await Promise.all(uniqueDirectories.map(inspectPrivateDirectory));
  for (const [index, directory] of uniqueDirectories.entries()) {
    if (!existingDirectories[index]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }
  const verifiedDirectories = await Promise.all(uniqueDirectories.map(inspectPrivateDirectory));
  for (const [index, exists] of verifiedDirectories.entries()) {
    if (!exists) {
      throw new Error(`private state directory was not created: ${uniqueDirectories[index]}`);
    }
  }
  await Promise.all(uniqueDirectories.map((directory) => chmod(directory, 0o700)));
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await ensurePrivateDirectories([directory]);
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: JsonWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectories(options.privateDirectories ?? []);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}
