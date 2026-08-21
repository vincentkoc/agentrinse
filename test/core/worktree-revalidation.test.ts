import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { GitWorktreeAuditAdapter } from "../../src/adapters/git/adapter.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { AgentRinseConfig } from "../../src/config/schema.js";
import type { WorktreeQuarantineAction } from "../../src/contracts/action.js";
import type { AuditReport } from "../../src/contracts/report.js";
import { runAudit } from "../../src/core/audit.js";
import {
  currentWorktreeProtectionRoots,
  revalidateWorktreeQuarantine,
} from "../../src/core/worktree-revalidation.js";

const execFileAsync = promisify(execFile);

const ACTION: WorktreeQuarantineAction = {
  actionId: "worktree.quarantine:fixture",
  type: "worktree.quarantine",
  adapter: "git",
  resourceId: "git:git-worktree:fixture",
  risk: "recoverable",
  description: "quarantine fixture",
  expectedReclaimBytes: 0,
  pendingQuarantineBytes: 1024,
  quarantineTtlMinutes: 60,
  target: {
    path: "/tmp/worktree",
    repositoryCommonDir: "/tmp/repo/.git",
    head: "a".repeat(40),
    branch: "refs/heads/feature",
    device: 1,
    inode: 2,
    mtimeMs: 3,
    measuredBytes: 1024,
    newestMtimeMs: 4,
    fingerprint: "b".repeat(64),
  },
};

function report(action: WorktreeQuarantineAction = ACTION): AuditReport {
  return {
    schemaVersion: 1,
    auditId: "audit-fresh",
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: "2026-07-24T00:00:01.000Z",
    home: "/tmp",
    probes: [],
    findings: [
      {
        schemaVersion: 1,
        findingId: "finding-fresh",
        auditId: "audit-fresh",
        observedAt: "2026-07-24T00:00:00.000Z",
        resource: {
          id: ACTION.resourceId,
          adapter: "git",
          kind: "git-worktree",
          canonicalKey: "git:/tmp/worktree",
          displayName: "Linked worktree",
          path: ACTION.target.path,
        },
        state: "eligible",
        confidence: "certain",
        roots: [],
        facts: {},
        candidateActions: [action],
        measuredBytes: 1024,
        estimatedReclaimBytes: 0,
        warnings: [],
      },
    ],
    diagnostics: [],
  };
}

describe("revalidateWorktreeQuarantine", () => {
  it("accepts only the exact freshly audited action", async () => {
    const audit = vi.fn(async () => report());

    const result = await revalidateWorktreeQuarantine(ACTION, "/tmp", DEFAULT_CONFIG, {
      platform: "linux",
      audit,
    });

    expect(result.status).toBe("valid");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("rejects changed identity even when the resource remains eligible", async () => {
    const changed: WorktreeQuarantineAction = {
      ...ACTION,
      target: { ...ACTION.target, fingerprint: "c".repeat(64) },
    };

    const result = await revalidateWorktreeQuarantine(ACTION, "/tmp", DEFAULT_CONFIG, {
      platform: "darwin",
      audit: async () => report(changed),
    });

    expect(result).toMatchObject({
      status: "stale",
      diagnostic: { code: "WORKTREE_IDENTITY_CHANGED" },
    });
  });

  it("blocks a worktree newly referenced by provider metadata", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "agentrinse-revalidation-")));
    const main = join(home, "repo");
    const linked = join(home, "task");
    const remote = join(home, "remote.git");
    const codexRoot = join(home, ".codex");
    const metadataPath = join(codexRoot, ".codex-global-state.json");
    await mkdir(codexRoot, { recursive: true });
    await writeFile(
      metadataPath,
      JSON.stringify({
        "active-workspace-roots": [],
        "electron-saved-workspace-roots": [],
        "thread-workspace-root-hints": {},
      }),
    );
    await execFileAsync("git", ["init", "--bare", remote]);
    await execFileAsync("git", ["init", "-b", "main", main]);
    await execFileAsync("git", ["-C", main, "config", "user.email", "fixture@example.test"]);
    await execFileAsync("git", ["-C", main, "config", "user.name", "AgentRinse Fixture"]);
    await writeFile(join(main, "README.md"), "fixture\n");
    await execFileAsync("git", ["-C", main, "add", "README.md"]);
    await execFileAsync("git", ["-C", main, "commit", "-m", "fixture"]);
    await execFileAsync("git", ["-C", main, "remote", "add", "origin", remote]);
    await execFileAsync("git", ["-C", main, "push", "-u", "origin", "main"]);
    await execFileAsync("git", ["-C", main, "branch", "task"]);
    await execFileAsync("git", ["-C", main, "push", "-u", "origin", "task"]);
    await execFileAsync("git", ["-C", main, "worktree", "add", linked, "task"]);

    const config: AgentRinseConfig = structuredClone(DEFAULT_CONFIG);
    for (const adapter of ["claude", "cursor", "copilot", "zed", "opencode", "grok"] as const) {
      config.adapters[adapter] = { enabled: false };
    }
    config.adapters.codex = { enabled: true, root: codexRoot };
    config.adapters.git = { enabled: true, root: main };
    config.worktrees = { ...config.worktrees, minAgeMinutes: 0 };
    config.pins = [];
    const platform = process.platform === "linux" ? "linux" : "darwin";
    const initial = await runAudit({
      home,
      config,
      adapters: [
        new GitWorktreeAuditAdapter(
          main,
          undefined,
          undefined,
          async () => ({ status: "idle", matches: [] }),
          undefined,
          {
            ...config.audit,
            ...config.worktrees,
            platform,
          },
        ),
      ],
    });
    const action = initial.findings
      .flatMap((finding) => finding.candidateActions)
      .find(
        (candidate): candidate is WorktreeQuarantineAction =>
          candidate.type === "worktree.quarantine" && candidate.target.path === linked,
      );
    expect(action).toBeDefined();

    const otherRepository = join(home, "other-repo");
    await execFileAsync("git", ["init", "-b", "main", otherRepository]);
    config.adapters.git = { enabled: true, root: otherRepository };
    config.pins = [{ gitRef: "refs/tags/keep" }];
    await execFileAsync("git", ["-C", linked, "tag", "--no-sign", "keep"]);
    await writeFile(
      metadataPath,
      JSON.stringify({
        "active-workspace-roots": [linked],
        "electron-saved-workspace-roots": [],
        "thread-workspace-root-hints": {},
      }),
    );
    const result = await revalidateWorktreeQuarantine(action!, home, config, { platform });
    const roots = await currentWorktreeProtectionRoots(action!, home, config, new Date());

    expect(result).toMatchObject({
      status: "stale",
      diagnostic: {
        code: "WORKTREE_ELIGIBILITY_CHANGED",
        message: expect.stringContaining("active-session"),
      },
    });
    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "active-session" }),
        expect.objectContaining({ code: "user-pin" }),
      ]),
    );
  }, 30_000);

  it("blocks mutation on native Windows", async () => {
    const audit = vi.fn(async () => report());

    const result = await revalidateWorktreeQuarantine(ACTION, "/tmp", DEFAULT_CONFIG, {
      platform: "win32",
      audit,
    });

    expect(result).toMatchObject({
      status: "stale",
      diagnostic: { code: "WORKTREE_PLATFORM_UNSUPPORTED" },
    });
    expect(audit).not.toHaveBeenCalled();
  });
});
