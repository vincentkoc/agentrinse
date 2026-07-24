import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function syncDirectory(path: string): Promise<void> {
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

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`private state path is not a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`private state directory is not owned by the current user: ${directory}`);
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
