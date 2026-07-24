import { describe, expect, it } from "vitest";

import { resolveConfigPath } from "../../src/config/path.js";

describe("resolveConfigPath", () => {
  it("uses the explicit path first", () => {
    expect(resolveConfigPath("/tmp/home", "/tmp/config.json", {})).toBe("/tmp/config.json");
  });

  it("uses XDG_CONFIG_HOME when configured", () => {
    expect(resolveConfigPath("/tmp/home", undefined, { XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/agentrinse/config.json",
    );
  });

  it("falls back to the audited home", () => {
    expect(resolveConfigPath("/tmp/home", undefined, {})).toBe(
      "/tmp/home/.config/agentrinse/config.json",
    );
  });
});
