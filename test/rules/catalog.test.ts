import { providerFileRuleSchema, projectArtifactRuleSchema } from "../../src/rules/schema.js";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ArtifactAuditAdapter } from "../../src/adapters/artifacts/adapter.js";
import { classifyProviderFile } from "../../src/adapters/provider-file-classification.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { artifactNameSchema } from "../../src/contracts/action.js";
import type { Finding } from "../../src/contracts/finding.js";
import type { ResourceSnapshot } from "../../src/contracts/resource.js";
import { createCleanupPlan } from "../../src/core/plan.js";
import { fileRules, matchesRulePath, registerFileRules } from "../../src/rules/file-rule.js";

const root = dirname(fileURLToPath(import.meta.url));
const fixtureSchema = z.strictObject({
  rule: z.string(),
  accept: z.array(z.string()).min(1),
  reject: z.array(z.string()).min(1),
});

async function definitions(dir: string) {
  const output = new Map<string, unknown>();
  for (const owner of await readdir(dir, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    for (const file of await readdir(join(dir, owner.name))) {
      if (!file.endsWith(".json")) continue;
      output.set(
        owner.name + "." + file.slice(0, -5),
        JSON.parse(await readFile(join(dir, owner.name, file), "utf8")),
      );
    }
  }
  return output;
}

const rules = await definitions(join(root, "../../src/rules"));
const fixtures = await definitions(join(root, "fixtures"));
const now = new Date("2026-06-01T00:00:00Z");
// Classification and planning use synthetic observations only.
const home = join(tmpdir(), "agentrinse-rule-observations");
const context = { home, now, auditId: "rule-fixture" };
const stamp = now.toISOString();
const hash = "a".repeat(64);
function planned(finding: Finding, enabled = true) {
  return createCleanupPlan(
    {
      schemaVersion: 1,
      auditId: context.auditId,
      home,
      startedAt: stamp,
      completedAt: stamp,
      probes: [],
      findings: [finding],
      diagnostics: [],
    },
    {
      ...DEFAULT_CONFIG,
      adapters: { ...DEFAULT_CONFIG.adapters, [finding.resource.adapter]: { enabled } },
      plan: { ...DEFAULT_CONFIG.plan, maxRisk: "recoverable" },
    },
    now,
  ).actions;
}

describe("built-in rule fixtures", () => {
  it("pairs every rule with one fixture of the same owner and ID", () => {
    expect([...fixtures.keys()].sort()).toEqual([...rules.keys()].sort());
  });
  for (const [id, definition] of rules) {
    it(id, async () => {
      const cases = fixtureSchema.parse(fixtures.get(id));
      expect(cases.rule).toBe(id);
      const rule = fileRules.find((rule) => rule.id === id);
      if (rule) {
        for (const name of cases.reject)
          expect(matchesRulePath(rule, name.split("/").join(sep))).toBe(false);
        for (const name of cases.accept) {
          const relativePath = name.split("/").join(sep);
          expect(matchesRulePath(rule, relativePath)).toBe(true);
          for (const eligible of [true, false]) {
            const path = join(home, relativePath);
            const observation: ResourceSnapshot = {
              resource: {
                id: "fixture",
                adapter: rule.provider,
                kind: rule.resourceKind,
                canonicalKey: "fixture",
                displayName: name,
                path,
              },
              exists: true,
              observedAt: stamp,
              facts: {
                policyId: id,
                providerFileIdentity: {
                  provider: rule.provider,
                  relativePath,
                  path,
                  ownerRoot: home,
                  device: 1,
                  inode: 2,
                  linkCount: 1,
                  mode: 0o600,
                  mtimeMs: now.getTime() - rule.minAgeDays * 86_400_000 + (eligible ? 0 : 1),
                  measuredBytes: 10,
                  contentSha256: hash,
                  fingerprint: hash,
                },
              },
            };
            const finding = classifyProviderFile(rule.provider, context, observation)!;
            expect(planned(finding, false)).toEqual([]);
            expect(finding.state).toBe(eligible ? "eligible" : "protected");
            expect(planned(finding)).toMatchObject(
              eligible
                ? [
                    {
                      type: "provider.file-quarantine",
                      policyId: id,
                      expectedReclaimBytes: 0,
                      pendingQuarantineBytes: 10,
                    },
                  ]
                : [],
            );
          }
        }
        return;
      }
      const descriptor = projectArtifactRuleSchema.parse(definition);
      expect(descriptor.id).toBe(id);
      expect(cases.accept.toSorted()).toEqual(descriptor.names.toSorted());
      for (const name of cases.reject)
        expect(artifactNameSchema.safeParse(name).success).toBe(false);
      for (const name of cases.accept) {
        const project = { root: join(home, "project"), names: [artifactNameSchema.parse(name)] };
        const adapter = new ArtifactAuditAdapter({
          ...DEFAULT_CONFIG.artifacts,
          ...DEFAULT_CONFIG.audit,
          projects: [project],
        });
        for (const tracked of [false, true]) {
          const bytes = DEFAULT_CONFIG.artifacts.minBytes;
          const path = join(project.root, name);
          const finding = await adapter.classify(context, {
            resource: {
              id: "fixture",
              adapter: "artifacts",
              kind: "build-artifact",
              displayName: name,
              canonicalKey: "fixture",
              path,
            },
            exists: true,
            observedAt: stamp,
            measuredBytes: bytes,
            facts: {
              projectRoot: project.root,
              name,
              device: 1,
              inode: 2,
              mtimeMs: 0,
              newestMtimeMs: 0,
              fingerprint: hash,
              isDirectory: true,
              ageMinutes: DEFAULT_CONFIG.artifacts.minAgeMinutes,
              mountBoundaryStatus: "clear",
              processOwnership: { status: "idle" },
              gitState: { status: tracked ? "tracked" : "clear" },
            },
          });
          expect(finding.state).toBe(tracked ? "protected" : "eligible");
          expect(planned(finding)).toMatchObject(
            tracked ? [] : [{ type: "artifacts.remove", expectedReclaimBytes: bytes }],
          );
        }
      }
    });
  }

  it("refuses duplicate owners of a candidate and unbound native discovery", () => {
    const exact = rules.get("claude.changelog-cache") as Record<string, unknown>;
    const children = rules.get("claude.debug-log") as Record<string, unknown>;
    const native = rules.get("openclaw.shell-snapshot") as Record<string, unknown>;
    expect(() => registerFileRules([exact, exact])).toThrow("Conflicting file rules");
    expect(() =>
      registerFileRules([children, { ...exact, directory: ["DEBUG"], match: { name: "one.TXT" } }]),
    ).toThrow("Conflicting file rules");
    expect(() => registerFileRules([native, { ...native, id: "openclaw.second" }])).toThrow(
      "Conflicting file rules",
    );
    expect(() =>
      registerFileRules([{ ...exact, discovery: { kind: "native", collector: "missing" } }]),
    ).toThrow();
    expect(() => registerFileRules([{ ...exact, discovery: native.discovery }])).toThrow();
  });

  it("rejects paths which can escape root and incompatible discovery contracts", () => {
    const definition = rules.get("zed.rotated-log") as object;
    for (const dir of ["..", ".", "/tmp", "C:\\outside", "logs/sub"]) {
      expect(providerFileRuleSchema.safeParse({ ...definition, directory: [dir] }).success).toBe(
        false,
      );
    }
    expect(
      providerFileRuleSchema.safeParse({ ...definition, match: { suffix: ".log" } }).success,
    ).toBe(false);
    expect(providerFileRuleSchema.safeParse({ ...definition, command: "cleanup" }).success).toBe(
      false,
    );
  });
});
