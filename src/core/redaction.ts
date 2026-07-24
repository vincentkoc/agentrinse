import { posix, win32 } from "node:path";

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

type RedactionContext = {
  home: string;
  salt: string;
};

function token(kind: string, value: string, salt: string): string {
  return `${kind}:${sha256(`${salt}\0${value}`).slice(0, 16)}`;
}

function redactPath(value: string, home: string, salt: string): string {
  if (value === home) {
    return "$HOME";
  }
  if (value.startsWith(`${home}${posix.sep}`) || value.startsWith(`${home}${win32.sep}`)) {
    return `$HOME/<${token("path", value, salt)}>`;
  }
  return posix.isAbsolute(value) || win32.isAbsolute(value)
    ? `$PATH/<${token("path", value, salt)}>`
    : value;
}

function replacePathMatch(matched: string, context: RedactionContext): string {
  const suffix = matched.match(/[),.;:]+$/u)?.[0] ?? "";
  const path = suffix === "" ? matched : matched.slice(0, -suffix.length);
  return `${redactPath(path, context.home, context.salt)}${suffix}`;
}

function redactText(value: string, context: RedactionContext): string {
  let output = value;
  output = output.replace(/\\\\[\s\S]*/gu, (matched) => replacePathMatch(matched, context));
  output = output.replace(/(?<!\\)\\(?!\\)[\s\S]*/gu, (matched) =>
    replacePathMatch(matched, context),
  );
  output = output.replace(/(?<![$\w>])\/[\s\S]*/gu, (matched) =>
    replacePathMatch(matched, context),
  );
  return output.replace(/\b[A-Za-z]:\\[\s\S]*/gu, (matched) => replacePathMatch(matched, context));
}

function redactValue(value: unknown, context: RedactionContext, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && IDENTIFIER_KEYS.has(key)) {
      return token("id", value, context.salt);
    }
    if (key !== undefined && PATH_KEYS.has(key)) {
      return redactPath(value, context.home, context.salt);
    }
    return redactText(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, context, key));
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
      childKey === "candidateActions" ? [] : redactValue(childValue, context, childKey);
  }
  return output;
}

export function redactAuditValue<T>(value: T, home: string, salt: string): T {
  const context: RedactionContext = {
    home,
    salt,
  };
  return redactValue(value, context) as T;
}

export function redactAuditReport(report: AuditReport, salt: string): AuditReport {
  return redactAuditValue(report, report.home, salt);
}
