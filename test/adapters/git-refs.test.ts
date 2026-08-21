import { describe, expect, it } from "vitest";

import { isPushedHead, matchingGitRefPins } from "../../src/adapters/git/refs.js";

describe("bounded Git ref inspection", () => {
  it("proves remote reachability without enumerating containing refs", async () => {
    const commands: string[][] = [];
    const reachable = await isPushedHead(
      async (args) => {
        commands.push(args);
        return "";
      },
      {
        head: "a".repeat(40),
        ahead: 0,
        remoteConfigured: true,
        detached: false,
      },
    );

    expect(reachable).toBe(true);
    expect(commands).toEqual([["rev-list", "--max-count=1", "a".repeat(40), "--not", "--remotes"]]);
  });

  it("checks an upstream directly and refuses ahead or detached heads", async () => {
    const head = "c".repeat(40);
    const commands: string[][] = [];
    const runGit = async (args: string[]) => {
      commands.push(args);
      return "";
    };

    await expect(
      isPushedHead(runGit, {
        head,
        upstream: "origin/task",
        ahead: 0,
        remoteConfigured: true,
        detached: false,
      }),
    ).resolves.toBe(true);
    await expect(
      isPushedHead(runGit, {
        head,
        upstream: "origin/task",
        ahead: 1,
        remoteConfigured: true,
        detached: false,
      }),
    ).resolves.toBe(false);
    await expect(
      isPushedHead(runGit, {
        head,
        ahead: 0,
        remoteConfigured: true,
        detached: true,
      }),
    ).resolves.toBe(false);

    expect(commands).toEqual([
      ["rev-list", "--max-count=1", head, "--not", "refs/remotes/origin/task"],
    ]);
  });

  it("checks branch ancestry and exact tag targets only", async () => {
    const head = "b".repeat(40);
    const commands: string[][] = [];
    const matches = await matchingGitRefPins(
      async (args) => {
        commands.push(args);
        if (args[0] === "rev-parse") {
          return `${head}\n`;
        }
        return args.at(-1) === "refs/heads/keep" ? "" : `${head}\n`;
      },
      head,
      ["refs/heads/keep", "refs/remotes/origin/drop", "refs/tags/v1"],
    );

    expect(matches).toEqual(["refs/heads/keep", "refs/tags/v1"]);
    expect(commands.every((args) => !args.includes("for-each-ref"))).toBe(true);
  });
});
