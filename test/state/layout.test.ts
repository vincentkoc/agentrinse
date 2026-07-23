import { describe, expect, it } from "vitest";

import {
  resolveStateRoot,
  stateLayout,
} from "../../src/state/layout.js";

describe("state layout", () => {
  it("uses an explicit state root first", () => {
    expect(
      resolveStateRoot("/fixture/home", "/fixture/state", {
        XDG_STATE_HOME: "/ignored",
      }),
    ).toBe("/fixture/state");
  });

  it("uses XDG state when configured", () => {
    expect(
      resolveStateRoot("/fixture/home", undefined, {
        XDG_STATE_HOME: "/fixture/xdg",
      }),
    ).toBe("/fixture/xdg/agentrinse");
  });

  it("builds stable state subdirectories", () => {
    expect(stateLayout("/fixture/state")).toEqual({
      root: "/fixture/state",
      locks: "/fixture/state/locks",
      runs: "/fixture/state/runs",
      tombstones: "/fixture/state/tombstones",
    });
  });
});
