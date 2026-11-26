import { join } from "node:path";
import { readProjectFile } from "../../core/project-file.js";
import { cacheTagNames } from "../builtin.generated.js";

const taggedNames = new Set<string>(cacheTagNames);
const signature = Buffer.from("Signature: 8a477f597d28d172789f06886806bc55");
export function requiresCacheTag(name: unknown): boolean {
  return typeof name === "string" && taggedNames.has(name);
}

export async function hasCacheTag(dir: string, device: number): Promise<boolean> {
  const prefix = await readProjectFile(join(dir, "CACHEDIR.TAG"), device, {
    prefixBytes: signature.length + 2,
  });
  if (!prefix?.subarray(0, signature.length).equals(signature)) return false;
  return (
    prefix.length === signature.length ||
    prefix[signature.length] === 10 ||
    (prefix[signature.length] === 13 && prefix[signature.length + 1] === 10)
  );
}
