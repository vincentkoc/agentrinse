import { agentRinseConfigSchema, type AgentRinseConfig } from "./schema.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Version 1 config files historically ignore unknown fields. Explicit CLI assignments
// are an authoring interface: reject any field the parser would silently discard.
function checkAssignedKeys(input: unknown, parsed: unknown, path: string) {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    input.forEach((item, i) => checkAssignedKeys(item, parsed[i], path + "/" + i));
  } else if (object(input) && object(parsed)) {
    for (const [key, child] of Object.entries(input)) {
      if (!Object.hasOwn(parsed, key)) throw new Error("Unknown config field " + path + "/" + key);
      checkAssignedKeys(child, parsed[key], path + "/" + key);
    }
  }
}

export function renderConfig(
  base: AgentRinseConfig,
  assignments: readonly string[],
): AgentRinseConfig {
  const result: Record<string, unknown> = structuredClone(base);
  for (const assignment of assignments) {
    const equal = assignment.indexOf("=");
    const pointer = assignment.slice(0, equal);
    if (equal < 2 || !pointer.startsWith("/")) throw new Error("--set expects /field/path=JSON");
    const parts = pointer.slice(1).split("/");
    if (
      parts.some(
        (part) =>
          !/^[a-zA-Z0-9_.-]+$/u.test(part) ||
          ["__proto__", "constructor", "prototype"].includes(part),
      )
    )
      throw new Error("Invalid config field path");
    let record = result;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(record, part)) record[part] = {};
      const next = record[part];
      if (!object(next))
        throw new Error("Set arrays or scalar config fields as complete JSON values: " + pointer);
      record = next;
    }
    try {
      record[parts.at(-1)!] = JSON.parse(assignment.slice(equal + 1));
    } catch {
      throw new Error("--set requires a JSON value for " + pointer);
    }
  }
  const parsed = agentRinseConfigSchema.parse(result);
  checkAssignedKeys(result, parsed, "");
  return parsed;
}
