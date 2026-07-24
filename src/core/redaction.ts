import { isAbsolute, sep } from "node:path";

import type { AuditReport } from "../contracts/report.js";
import { sha256 } from "./digest.js";

const IDENTIFIER_KEYS = new Set([
  "Command",
  "Image",
  "Names",
  "Repository",
  "actionId",
  "auditId",
  "branch",
  "canonicalKey",
  "displayName",
  "evidenceRef",
  "externalId",
  "findingId",
  "head",
  "id",
  "resourceId",
]);
const PATH_KEYS = new Set([
  "home",
  "isolationPath",
  "mountBoundaryPaths",
  "path",
  "projectRoot",
  "root",
]);
const HOST_KEYS = new Set(["host", "hostname"]);

function token(kind: string, value: string, salt: string): string {
  return `${kind}:${sha256(`${salt}\0${value}`).slice(0, 16)}`;
}

function redactPath(value: string, home: string, salt: string): string {
  if (value === home) {
    return "$HOME";
  }
  if (value.startsWith(`${home}${sep}`)) {
    return `$HOME/<${token("path", value, salt)}>`;
  }
  return isAbsolute(value) ? `$PATH/<${token("path", value, salt)}>` : value;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactText(value: string, home: string, salt: string): string {
  const homePath = new RegExp(`${escapeRegularExpression(home)}[^\\s"'<>]*`, "gu");
  return value.replace(homePath, (matched) => {
    const suffix = matched.match(/[),.;:]+$/u)?.[0] ?? "";
    const path = suffix === "" ? matched : matched.slice(0, -suffix.length);
    return `${redactPath(path, home, salt)}${suffix}`;
  });
}

function redactValue(value: unknown, home: string, salt: string, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && IDENTIFIER_KEYS.has(key)) {
      return token("id", value, salt);
    }
    if (key !== undefined && PATH_KEYS.has(key)) {
      return redactPath(value, home, salt);
    }
    return redactText(value, home, salt);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, home, salt, key));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (HOST_KEYS.has(childKey)) {
      continue;
    }
    output[childKey] =
      childKey === "candidateActions" ? [] : redactValue(childValue, home, salt, childKey);
  }
  return output;
}

export function redactAuditValue<T>(value: T, home: string, salt: string): T {
  return redactValue(value, home, salt) as T;
}

export function redactAuditReport(report: AuditReport, salt: string): AuditReport {
  return redactAuditValue(report, report.home, salt);
}
