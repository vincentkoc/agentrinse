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

type RedactionContext = {
  home: string;
  salt: string;
  pathTrie: PathTrieNode;
};

type PathTrieNode = {
  children: Map<string, PathTrieNode>;
  path?: string;
};

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

function buildPathTrie(paths: Iterable<string>, home: string): PathTrieNode {
  const root: PathTrieNode = { children: new Map() };
  for (const path of paths) {
    if (path === home) {
      continue;
    }
    let node = root;
    for (let index = 0; index < path.length; index += 1) {
      const character = path[index] ?? "";
      let child = node.children.get(character);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.path = path;
  }
  return root;
}

function replaceKnownPaths(value: string, context: RedactionContext): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    let node = context.pathTrie;
    let scan = cursor;
    let match: string | undefined;
    while (scan < value.length) {
      const child = node.children.get(value[scan] ?? "");
      if (child === undefined) {
        break;
      }
      node = child;
      scan += 1;
      if (node.path !== undefined) {
        match = node.path;
      }
    }
    if (match === undefined) {
      output += value[cursor];
      cursor += 1;
      continue;
    }
    output += redactPath(match, context.home, context.salt);
    cursor += match.length;
  }
  return output;
}

function replacePathMatch(matched: string, context: RedactionContext): string {
  const suffix = matched.match(/[),.;:]+$/u)?.[0] ?? "";
  const path = suffix === "" ? matched : matched.slice(0, -suffix.length);
  return `${redactPath(path, context.home, context.salt)}${suffix}`;
}

function redactText(value: string, context: RedactionContext): string {
  let output = replaceKnownPaths(value, context);
  output = output.replace(/(?<![$\w:>])\/[^"'<>]*/gu, (matched) =>
    replacePathMatch(matched, context),
  );
  return output.replace(/\b[A-Za-z]:\\[^"'<>]*/gu, (matched) => replacePathMatch(matched, context));
}

function collectPaths(value: unknown, key: string | undefined, paths: Set<string>): void {
  if (typeof value === "string") {
    if (key !== undefined && PATH_KEYS.has(key) && isAbsolute(value)) {
      paths.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaths(item, key, paths);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    collectPaths(childValue, childKey, paths);
  }
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
  const paths = new Set<string>([home]);
  collectPaths(value, undefined, paths);
  const context: RedactionContext = {
    home,
    salt,
    pathTrie: buildPathTrie(paths, home),
  };
  return redactValue(value, context) as T;
}

export function redactAuditReport(report: AuditReport, salt: string): AuditReport {
  return redactAuditValue(report, report.home, salt);
}
