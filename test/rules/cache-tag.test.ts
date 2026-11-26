import { execFileSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureDirectory } from "../helpers/fixture-directory.js";
import { describe, expect, it } from "vitest";
import { ArtifactAuditAdapter } from "../../src/adapters/artifacts/adapter.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { executeArtifactRemove } from "../../src/core/artifact-executor.js";
import { revalidateArtifactRemove } from "../../src/core/artifact-revalidation.js";
import { hasCacheTag } from "../../src/rules/build/cache-tag.js";

const signature = "Signature: 8a477f597d28d172789f06886806bc55";
async function fixture() {
  const home = await realpath(createFixtureDirectory(join(tmpdir(), "agentrinse-tag-")));
  const project = join(home, "project");
  const dir = join(project, ".pytest_cache");
  await mkdir(dir, { recursive: true });
  const tag = join(dir, "CACHEDIR.TAG");
  const device = (await lstat(dir)).dev;
  const config = structuredClone(DEFAULT_CONFIG);
  config.artifacts = {
    ...config.artifacts,
    projects: [{ root: project, names: [".pytest_cache"] }],
    minBytes: 1,
    minAgeMinutes: 0,
  };
  const idle = async (): Promise<{ status: "idle"; matches: [] }> => ({
    status: "idle",
    matches: [],
  });
  const adapter = new ArtifactAuditAdapter(
    { ...config.artifacts, ...config.audit },
    idle,
    async () => ({ status: "clear", paths: [] }),
  );
  const context = { home, now: new Date(Date.now() + 60_000), auditId: "cache-proof" };
  const observe = async () => {
    const snapshot = (await adapter.collect(context, await adapter.probe(context))).resources[0]!;
    return { snapshot, finding: await adapter.classify(context, snapshot) };
  };
  return { home, dir, tag, project, device, context, config, adapter, idle, observe };
}
describe("project cache declarations", () => {
  it("accepts only the exact signature at EOF or on its own first line", async () => {
    const { dir, tag, device } = await fixture();
    for (const suffix of ["", "\n# cache", "\r\ncomment", "\n" + "x".repeat(100_000)]) {
      await writeFile(tag, signature + suffix);
      expect(await hasCacheTag(dir, device)).toBe(true);
    }
    for (const text of [
      "",
      signature.slice(0, -1),
      signature + "x",
      signature + "\r",
      signature.toLowerCase(),
      "\n" + signature,
    ]) {
      await writeFile(tag, text);
      expect(await hasCacheTag(dir, device)).toBe(false);
    }
  });
  it("rejects missing declarations, linked markers and pipes without probing holders", async () => {
    const { dir, tag, project, device, observe } = await fixture();
    const other = join(project, "other");
    await writeFile(other, signature);
    for (const type of ["missing", "hardlink", "symlink", "fifo"]) {
      if (type === "hardlink") await link(other, tag);
      if (type === "symlink") {
        await rm(tag);
        await symlink(other, tag);
      }
      if (type === "fifo") {
        await rm(tag);
        execFileSync("mkfifo", [tag]);
      }
      expect(await hasCacheTag(dir, device)).toBe(false);
      const { finding } = await observe();
      expect(finding).toMatchObject({
        state: "blocked",
        candidateActions: [],
        facts: { processOwnership: { status: "not-probed" } },
        warnings: [{ code: "ARTIFACT_CACHE_TAG_UNVERIFIED" }],
      });
    }
  });
  it("retains a cache whose declaration is overwritten during the final authorization", async () => {
    const { tag, observe, idle } = await fixture();
    await writeFile(tag, signature);
    const action = (await observe()).finding.candidateActions[0]!;
    if (action.type !== "artifacts.remove") throw new Error("missing cache action");
    let refreshes = 0;
    await expect(
      executeArtifactRemove(action, {
        processProbe: idle,
        revalidateProtection: async (path) => {
          if (++refreshes === 2)
            await writeFile(join(path, "CACHEDIR.TAG"), signature.toLowerCase());
        },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      message: expect.stringContaining("final authorization"),
    });
    expect(await readFile(tag, "utf8")).toBe(signature.toLowerCase());
  });

  it("requires marker evidence to classify and rechecks changed markers during apply", async () => {
    const { home, dir, tag, config, context, observe, adapter, idle } = await fixture();
    await writeFile(tag, signature);
    const { snapshot, finding } = await observe();
    expect(finding.state).toBe("eligible");
    const action = finding.candidateActions[0]!;
    if (action.type !== "artifacts.remove") throw new Error("missing artifact action");
    delete snapshot.facts.cacheTagVerified;
    expect((await adapter.classify(context, snapshot)).candidateActions).toEqual([]);
    await writeFile(tag, signature.replace("Signature", "signature"));
    expect(
      await revalidateArtifactRemove(action, home, config, { processProbe: idle }),
    ).toMatchObject({ status: "stale", diagnostic: { code: "ARTIFACT_CACHE_TAG_UNVERIFIED" } });
    await writeFile(tag, signature);
    const fresh = (await observe()).finding.candidateActions[0]!;
    if (fresh.type !== "artifacts.remove") throw new Error("missing fresh artifact action");
    await expect(
      executeArtifactRemove(fresh, {
        processProbe: idle,
        revalidateProtection: async (isolation) => {
          const isolatedTag = join(isolation, "CACHEDIR.TAG");
          await rm(isolatedTag);
          await writeFile(isolatedTag, "replacement");
        },
      }),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      message: expect.stringContaining("cache declaration"),
    });
    expect(await readFile(join(dir, "CACHEDIR.TAG"), "utf8")).toBe("replacement");
  });
});
