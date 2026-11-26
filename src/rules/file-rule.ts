import { sep } from "node:path";

import { providerFileRuleSchema, type ProviderFileRule } from "./schema.js";
export type { ProviderFileRule } from "./schema.js";
import { fileRuleDefinitions } from "./builtin.generated.js";

export function matchesRulePath(rule: ProviderFileRule, relativePath: string): boolean {
  const parts = relativePath.split(sep);
  const name = parts.pop();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    parts.length !== rule.directory.length ||
    !parts.every((part, i) => part === rule.directory[i])
  )
    return false;
  if ("name" in rule.match) return name === rule.match.name;
  if ("suffix" in rule.match) return name.endsWith(rule.match.suffix);
  const suffix = rule.match.sha256Suffix;
  return name.endsWith(suffix) && /^[a-f0-9]{64}$/u.test(name.slice(0, -suffix.length));
}

type NameMatch = ProviderFileRule["match"];

function overlaps(a: NameMatch, b: NameMatch): boolean {
  if ("name" in a) {
    const name = a.name.toLowerCase();
    if ("name" in b) return name === b.name.toLowerCase();
    if ("suffix" in b) return name.endsWith(b.suffix.toLowerCase());
    const suffix = b.sha256Suffix.toLowerCase();
    return name.endsWith(suffix) && /^[a-f0-9]{64}$/u.test(name.slice(0, -suffix.length));
  }
  if ("name" in b) return overlaps(b, a);
  return (
    ("suffix" in a ? a.suffix : a.sha256Suffix).toLowerCase() ===
    ("suffix" in b ? b.suffix : b.sha256Suffix).toLowerCase()
  );
}

function relativeDirectory(rule: ProviderFileRule) {
  // On Linux and under an explicit Zed root its log directory is <provider>/logs.
  const base = rule.ownerRoot === "zed-log-root" ? ["logs"] : [];
  return [...base, ...rule.directory].join("/").toLowerCase();
}

export function registerFileRules(definitions: readonly unknown[]) {
  const registered = definitions.map((definition) => providerFileRuleSchema.parse(definition));
  for (const [index, rule] of registered.entries()) {
    for (const other of registered.slice(0, index)) {
      if (
        rule.id === other.id ||
        (rule.discovery.kind === "native" &&
          other.discovery.kind === "native" &&
          rule.discovery.collector === other.discovery.collector) ||
        (rule.provider === other.provider &&
          relativeDirectory(rule) === relativeDirectory(other) &&
          overlaps(rule.match, other.match))
      ) {
        throw new Error("Conflicting file rules " + other.id + " and " + rule.id);
      }
    }
  }
  return registered
    .map((rule) => ({
      ...rule,
      minAgeMinutes: rule.minAgeDays * 1440,
      quarantineTtlMinutes: rule.quarantineDays * 1440,
    }))
    .sort(
      (a, b) =>
        (a.discovery.kind === "native" ? 100 : (a.discovery.order ?? 100)) -
        (b.discovery.kind === "native" ? 100 : (b.discovery.order ?? 100)),
    );
}

export const fileRules = registerFileRules(fileRuleDefinitions);

export function nativeFileRule(
  collector: Extract<ProviderFileRule["discovery"], { kind: "native" }>["collector"],
) {
  return fileRules.find(
    (rule) => rule.discovery.kind === "native" && rule.discovery.collector === collector,
  );
}

export function matchProviderFilePolicy(provider: string, id: unknown, relativePath: string) {
  return fileRules.find(
    (rule) => rule.provider === provider && rule.id === id && matchesRulePath(rule, relativePath),
  );
}
