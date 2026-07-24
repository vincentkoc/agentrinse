import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ZodType } from "zod";

import { readJsonFile } from "./json-file.js";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function listJsonRecords<T>(directory: string, schema: ZodType<T>): Promise<T[]> {
  return (await listJsonRecordFiles(directory, schema)).map((record) => record.value);
}

export type JsonRecordFile<T> = {
  name: string;
  path: string;
  value: T;
};

export async function listJsonRecordFiles<T>(
  directory: string,
  schema: ZodType<T>,
): Promise<JsonRecordFile<T>[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const records: JsonRecordFile<T>[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = resolve(directory, name);
    records.push({
      name,
      path,
      value: schema.parse(await readJsonFile(path)),
    });
  }
  return records;
}

export async function readJsonRecord<T>(
  directory: string,
  idOrPath: string,
  schema: ZodType<T>,
): Promise<T> {
  const path = resolveJsonRecordPath(directory, idOrPath);
  return schema.parse(await readJsonFile(path));
}

export function resolveJsonRecordPath(directory: string, idOrPath: string): string {
  const explicitPath =
    isAbsolute(idOrPath) ||
    idOrPath.endsWith(".json") ||
    idOrPath.includes("/") ||
    idOrPath.includes("\\");
  return explicitPath ? resolve(idOrPath) : resolve(directory, `${idOrPath}.json`);
}
