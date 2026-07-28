import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, win32 as windowsPath } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const windowsPrivateDirectoryPathEnvironmentVariable = "AGENTRINSE_PRIVATE_DIRECTORY";

const secureWindowsPrivateDirectoryCommand = `
$directory = [System.IO.DirectoryInfo]::new([Environment]::GetEnvironmentVariable('${windowsPrivateDirectoryPathEnvironmentVariable}'))
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$identities = @($currentUser, $system, $administrators) | Group-Object Value | ForEach-Object { $_.Group[0] }
$allowedSids = @($identities | ForEach-Object { $_.Value })
$acl = $directory.GetAccessControl()
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if (-not $owner.Equals($currentUser)) { throw "private state directory is not owned by the current user: $($directory.FullName)" }
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void] $acl.RemoveAccessRuleAll($rule) }
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [System.Security.AccessControl.InheritanceFlags]::ContainerInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
foreach ($sid in $identities) { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $full, $inheritance, $propagation, $allow)) }
$directory.SetAccessControl($acl)
$verified = $directory.GetAccessControl()
$verifiedOwner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
if (-not $verifiedOwner.Equals($currentUser)) { throw "private state directory is not owned by the current user after ACL update: $($directory.FullName)" }
$rules = @($verified.Access)
if ($rules.Count -ne $allowedSids.Count) { throw "private state directory has unexpected access rules after ACL update: $($directory.FullName)" }
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
  if ($rule.AccessControlType -ne $allow -or $allowedSids -notcontains $sid.Value -or $rule.FileSystemRights -ne $full -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne $propagation -or $rule.IsInherited) { throw "private state directory ACL verification failed: $($directory.FullName)" }
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

async function secureWindowsPrivateDirectory(directory: string): Promise<void> {
  await execFileAsync(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", secureWindowsPrivateDirectoryCommand],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        [windowsPrivateDirectoryPathEnvironmentVariable]: directory,
      },
      windowsHide: true,
    },
  );
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`private state path is not a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`private state directory is not owned by the current user: ${directory}`);
  }
  if (process.platform === "win32") {
    await secureWindowsPrivateDirectory(directory);
    return;
  }
  await chmod(directory, 0o700);
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: JsonWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  for (const privateDirectory of new Set(options.privateDirectories ?? [])) {
    await ensurePrivateDirectory(privateDirectory);
  }
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
