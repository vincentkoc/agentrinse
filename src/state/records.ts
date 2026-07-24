import { readdir } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { ZodType } from "zod";

import { readJsonFile } from "./json-file.js";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function listJsonRecords<T>(directory: string, schema: ZodType<T>): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const records: T[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    records.push(schema.parse(await readJsonFile(resolve(directory, name))));
  }
  return records;
}

export async function readJsonRecord<T>(
  directory: string,
  idOrPath: string,
  schema: ZodType<T>,
): Promise<T> {
  const explicitPath = isAbsolute(idOrPath) || idOrPath.includes(sep);
  const path = explicitPath ? resolve(idOrPath) : resolve(directory, `${idOrPath}.json`);
  return schema.parse(await readJsonFile(path));
}
