import {
  commandEnvelopeSchema,
  commandEventSchema,
  type CommandEnvelope,
  type CommandEnvelopeStatus,
  type CommandEvent,
} from "./contracts/output.js";
import type { Diagnostic } from "./contracts/diagnostic.js";
import { VERSION } from "./version.js";

export function createCommandEnvelope<T>(options: {
  command: string;
  startedAt: string;
  completedAt: string;
  status: CommandEnvelopeStatus;
  data: T;
  diagnostics?: Diagnostic[];
}): CommandEnvelope<T> {
  return commandEnvelopeSchema.parse({
    schemaVersion: 1,
    command: options.command,
    agentrinseVersion: VERSION,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    status: options.status,
    data: options.data,
    diagnostics: options.diagnostics ?? [],
  }) as CommandEnvelope<T>;
}

export function createCommandEvent<T>(options: {
  event: string;
  timestamp: string;
  command: string;
  commandId: string;
  sequence: number;
  data?: T;
}): CommandEvent<T> {
  return commandEventSchema.parse({
    schemaVersion: 1,
    event: options.event,
    timestamp: options.timestamp,
    command: options.command,
    commandId: options.commandId,
    sequence: options.sequence,
    ...(options.data === undefined ? {} : { data: options.data }),
  }) as CommandEvent<T>;
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function ndjsonRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
