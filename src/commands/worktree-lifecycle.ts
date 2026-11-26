import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const statusSchema = z.object({
  worktree: z.string().refine(isAbsolute),
  state: z.string(),
  checkout: z.string(),
  retirement_state: z.string(),
  pins: z.array(z.unknown()),
  owners: z
    .array(z.object({ owner: z.string(), completed: z.union([z.literal(0), z.literal(1)]) }))
    .optional(),
  released_owners: z.array(z.string()).optional(),
  cancelled_owners: z.array(z.object({ owner: z.string(), head: z.string() })).optional(),
});
export type GwtStatus = z.infer<typeof statusSchema>;

export async function readGwtInput(input: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024 * 1024) throw new Error("GWT status exceeds 64 MiB");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Expected valid JSON from gwt finish-status --all --read-only");
  }
  return value;
}

export function legacyGwtStatus(value: unknown): Map<string, GwtStatus[]> {
  const records = z.array(statusSchema).max(100_000).safeParse(value);
  if (!records.success)
    throw new Error("Expected a JSON array from gwt finish-status --all --read-only");
  const byPath = new Map<string, GwtStatus[]>();
  for (const record of records.data) {
    const path = resolve(record.worktree);
    const existing = byPath.get(path);
    if (existing) existing.push(record);
    else byPath.set(path, [record]);
  }
  return byPath;
}

export async function readGwtStatus(input: AsyncIterable<Uint8Array>) {
  return legacyGwtStatus(await readGwtInput(input));
}

export type Lifecycle =
  | "unreported"
  | "active"
  | "finished"
  | "cancelled"
  | "pinned"
  | "unresolved"
  | "removed";

export function lifecycleFor(records: GwtStatus[] | undefined, currentHead?: string): Lifecycle {
  if (records === undefined) return "unreported";
  if (records.length !== 1) return "unresolved";
  const [record] = records;
  if (!record) return "unresolved";
  if (currentHead && record.cancelled_owners?.some((owner) => owner.head !== currentHead))
    return "unresolved";
  if (record.pins.length) return "pinned";
  if (record.checkout === "removed") return "removed";
  if (
    record.checkout !== "retained" ||
    !["enrolled", "report-only"].includes(record.retirement_state)
  )
    return "unresolved";
  if (record.state === "active" || record.state === "finished" || record.state === "cancelled")
    return record.state;
  return "unresolved";
}

export function ownerSignoffFor(records: GwtStatus[] | undefined, head?: string) {
  if (records?.length !== 1 || !records[0]) return "unknown";
  const record = records[0];
  if (record.retirement_state === "report-only") return "report-only";
  if (record.retirement_state !== "enrolled" || !record.owners?.length || !record.released_owners)
    return "unknown";
  const owners = record.owners.map((row) => row.owner);
  if (
    new Set(owners).size !== owners.length ||
    owners.some((owner) => !owner) ||
    record.released_owners.some((owner) => !owners.includes(owner))
  )
    return "unknown";
  if (
    record.state === "finished" &&
    record.owners.every((row) => row.completed === 1 && record.released_owners?.includes(row.owner))
  )
    return "released";
  if (
    record.state === "cancelled" &&
    head &&
    record.cancelled_owners?.length &&
    record.cancelled_owners.every((row) => row.head === head && owners.includes(row.owner)) &&
    record.owners.every(
      (row) =>
        row.completed === 1 ||
        record.cancelled_owners?.some((cancelled) => cancelled.owner === row.owner),
    )
  )
    return "cancelled";
  return "pending";
}
